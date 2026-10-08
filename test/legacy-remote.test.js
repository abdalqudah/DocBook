// Direct pull from Clinica: signs in with the page's own form (hidden fields kept), reads each imported patient's pages,
// downloads only the attachments not here yet into the patient's file, signs in again when Clinica's session ends,
// counts what it found / downloaded / skipped / failed; a wrong password is said at once; the password is not stored.
process.env.NODE_ENV = 'test';
process.env.LEGACY_REMOTE_DELAY_MS = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-remote-'));
process.env.LEGACY_FILES_DIR = path.join(TMP, 'files');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const remote = require('../src/modules/legacy/remote.service');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let clinica; let base; let ctx;
const hits = { login: 0, files: 0 };
let sessionsLeft = Infinity; // pages served before Clinica ends the session

// A small stand-in for Clinica: a sign-in form with a hidden token, a cookie session, patient pages with file links.
function fakeClinica() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const live = new Set();
  const signedIn = (req) => { const m = /sid=([a-z0-9]+)/.exec(req.headers.cookie || ''); return m && live.has(m[1]) ? m[1] : null; };
  const form = '<html><body><form action="/user/login" method="post" id="user-login"><input type="text" name="name"><input type="password" name="pass"><input type="hidden" name="form_build_id" value="fb-123"><input type="submit" name="op" value="Log in"></form></body></html>';
  app.get('/user/login', (req, res) => res.send(form));
  app.post('/user/login', (req, res) => {
    hits.login += 1;
    if (req.body.name === 'owner' && req.body.pass === 's3cret' && req.body.form_build_id === 'fb-123' && req.body.op === 'Log in') {
      const sid = `s${hits.login}`; live.add(sid); res.set('Set-Cookie', `sid=${sid}; Path=/; HttpOnly`); return res.redirect(302, '/');
    }
    return res.send(form);
  });
  app.get('/', (req, res) => res.send(signedIn(req) ? '<html>Dashboard</html>' : form));
  const guard = (req, res, next) => {
    const sid = signedIn(req);
    if (!sid) return res.redirect(302, '/user/login');
    if (sessionsLeft <= 0) { live.delete(sid); sessionsLeft = Infinity; return res.redirect(302, '/user/login'); } // the session ends once
    sessionsLeft -= 1;
    return next();
  };
  app.get('/dental/:id', guard, (req, res) => {
    if (req.params.id !== '1001') return res.send('<html><table><tr><td>No files</td></tr></table></html>');
    return res.send(`<html><table>
      <tr><td><a href="/system/files/2022/2253/1001/%D8%B5%D9%88%D8%B1%D8%A9.png">صورة.png</a></td><td>2022-05-01</td></tr>
      <tr><td><a href='https://other.example/system/files/x.pdf'>elsewhere</a></td></tr>
      <tr><td><a href="/system/files/2021/2253/old.pdf">old.pdf</a></td></tr>
      <tr><td><a href="/system/files/2021/2253/gone.pdf">gone.pdf</a></td></tr></table></html>`);
  });
  app.get('/edit_patient/:id', guard, (req, res) => res.send(req.params.id === '1001' ? '<a href="/system/files/2022/2253/1001/report.pdf">report</a><img src="/system/files/2022/2253/1001/%D8%B5%D9%88%D8%B1%D8%A9.png">' : '<html></html>'));
  app.get('/system/files/*', guard, (req, res) => {
    hits.files += 1;
    if (req.path.endsWith('gone.pdf')) return res.status(404).send('Not found');
    return res.type(req.path.endsWith('.png') ? 'image/png' : 'application/pdf').send(req.path.endsWith('.png') ? PNG : PDF);
  });
  return app;
}

test.before(async () => {
  await knex.migrate.latest();
  clinica = fakeClinica().listen(0);
  await new Promise((r) => clinica.once('listening', r));
  base = `http://127.0.0.1:${clinica.address().port}`;
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: `lr${tag}@t.test`, password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Remote clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ media_quota_mb: 500 });
  ctx = { businessId, userId, roleKey: 'owner' };
});
test.after(async () => { clinica.close(); await knex.destroy(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('parsing: the sign-in form and the attachment links of a page', () => {
  const f = remote.loginForm('<form action="/user/login?x=1&amp;y=2"><input name="name" type="text"><input name="pass" type="password"><input type="hidden" name="t" value="a&amp;b"></form>');
  assert.equal(f.action, '/user/login?x=1&y=2'); assert.equal(f.userInput.name, 'name'); assert.equal(f.passInput.name, 'pass');
  assert.equal(f.inputs.find((i) => i.name === 't').value, 'a&b');
  assert.equal(remote.loginForm('<form><input name="q"></form>'), null);
  const links = remote.attachmentLinks('<a href="/system/files/a%20b.pdf">x</a><a href="https://evil.example/system/files/c.pdf">y</a><img src="/system/files/a b.pdf">', 'https://c.example/dental/1', 'https://c.example');
  assert.deepEqual(links.map((l) => l.name), ['a b.pdf'], 'one link (written two ways), same address only');
  assert.throws(() => remote.baseOf('not a url'));
});

test('pull: only the missing files, into the patient file; re-sign-in when the session ends; counts; a wrong password', async () => {
  const [pid] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'مريض', legacy_source: 'clinica', legacy_patient_id: '1001' });
  const [pid2] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'مريض 2', legacy_source: 'clinica', legacy_patient_id: '1002' });
  await knex('legacy_patients').insert([{ business_id: ctx.businessId, legacy_source: 'clinica', legacy_patient_id: '1001', patient_id: pid }, { business_id: ctx.businessId, legacy_source: 'clinica', legacy_patient_id: '1002', patient_id: pid2 }]);
  // old.pdf came with the first extraction (same address)
  await knex('patient_attachments').insert({ business_id: ctx.businessId, patient_id: pid, legacy_source: 'clinica', legacy_patient_id: '1001', original_filename: 'old.pdf', stored_filename: 'old.pdf', mime_type: 'application/pdf', category: 'document', file_size: 3, storage_path: 'x/old', checksum: 'f'.repeat(64), source_url: `${base}/system/files/2021/2253/old.pdf` });

  await assert.rejects(() => remote.start(ctx, { baseUrl: base, username: 'owner', password: 'wrong' }), (e) => e.status === 422 || e.code === 'VALIDATION_ERROR' || Boolean(e.details));
  assert.equal((await remote.progress(ctx.businessId)), null, 'nothing started with a wrong password');

  sessionsLeft = 3; // Clinica ends the session after three pages: signed in again, the pull carries on
  await remote.start(ctx, { baseUrl: base, username: 'owner', password: 's3cret' });
  await remote.settle(ctx.businessId);
  const p = await remote.progress(ctx.businessId);
  assert.equal(p.status, 'completed_with_issues');
  assert.deepEqual([p.patients.done, p.patients.total, p.found, p.downloaded, p.skipped, p.failed, p.remaining], [2, 2, 4, 2, 1, 1, 0]);
  assert.equal(p.errors[0].error_code, 'SOURCE_NOT_FOUND');
  assert.ok(hits.login >= 2, 'signed in again');
  const atts = await knex('patient_attachments').where({ business_id: ctx.businessId, patient_id: pid }).orderBy('id');
  assert.deepEqual(atts.map((a) => a.original_filename).sort(), ['old.pdf', 'report.pdf', 'صورة.png'].sort());
  const png = atts.find((a) => a.original_filename === 'صورة.png');
  assert.equal(png.mime_type, 'image/png'); assert.equal(png.legacy_source, 'clinica');
  assert.ok(fs.existsSync(path.join(process.env.LEGACY_FILES_DIR, png.storage_path)));
  // The password is nowhere in the database.
  const job = await knex('import_jobs').where({ business_id: ctx.businessId, type: remote.TYPE }).first();
  assert.doesNotMatch(JSON.stringify(job), /s3cret/);
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'legacy.remote_completed' }).first());

  // Running it again downloads nothing new.
  const before = hits.files;
  await remote.start(ctx, { baseUrl: base, username: 'owner', password: 's3cret' });
  await remote.settle(ctx.businessId);
  const again = await remote.progress(ctx.businessId);
  assert.equal(again.downloaded, 0); assert.equal(again.skipped, 3);
  assert.equal(hits.files - before, 1, 'only the missing (404) file is asked for again');
});
