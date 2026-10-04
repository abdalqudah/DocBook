// Platform admin → Compress old images: stored PNG/JPEG pictures become WebP (sizes, hashes and names updated),
// PDFs and signatures are left alone, a picture is never tried twice, only platform admins reach the page.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const opt = require('../src/core/imageopt');
const svc = require('../src/modules/platformops/imagecompress.service');
const { serve } = require('./_http');

require('http').globalAgent = new (require('http').Agent)({ keepAlive: false }); // the job keeps the server busy for a while

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `ica-${k}-${tag}@t.test`;
let app; let bid; let mediaId; let fileId; let pdfId; let logoBefore;

function photo(w, h) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) p.data.set([(x * 7 + y * 3) % 256, (x * y) % 256, (x ^ y) % 256, 255], (y * w + x) * 4);
  return PNG.sync.write(p);
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const mk = async (k, admin) => {
    const id = await knex.transaction(async (trx) => {
      const u = await auth.createUser(trx, { name: k, email: mail(k), password: 'Passw0rd!x' });
      await businesses.create(u, { name: `Clinic ${k}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
      return u;
    });
    await knex('users').where({ id }).update({ email_verified_at: new Date(), is_platform_admin: Boolean(admin) });
    const { last_business_id: b } = await knex('users').where({ id }).first('last_business_id');
    await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
    return b;
  };
  await mk('root', true);
  bid = await mk('owner', false);
  const big = photo(2500, 1200);
  await knex('businesses').where({ id: bid }).update({ logo: photo(1600, 400), logo_mime: 'image/png' });
  logoBefore = await knex('businesses').where({ id: bid }).first('logo_version');
  [mediaId] = await knex('clinic_media').insert({ business_id: bid, name: 'cover.png', folder: '', mime: 'image/png', size: big.length, width: 2500, height: 1200, sha: 'aaaaaaaaaaaaaaaa', data: big, is_public: true });
  const [pid] = await knex('patients').insert({ business_id: bid, full_name: 'Old Scan', phone: '0790000000' });
  [fileId] = await knex('patient_files').insert({ business_id: bid, patient_id: pid, category: 'scan', name: 'xray.png', mime: 'image/png', size: big.length, sha256: 'x'.repeat(64), data: big });
  [pdfId] = await knex('patient_files').insert({ business_id: bid, patient_id: pid, category: 'lab_result', name: 'cbc.pdf', mime: 'application/pdf', size: PDF.length, sha256: 'y'.repeat(64), data: PDF });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('only a platform admin opens the page', async () => {
  const o = app.agent(); await o.login(mail('owner'));
  assert.equal((await o.get('/admin/images')).status, 404);
  const a = app.agent(); await a.login(mail('root'));
  const page = await a.get('/admin/images');
  assert.equal(page.status, 200);
  assert.match(page.text, /action="\/admin\/images\/start"/);
  assert.ok((await svc.scan()).find((r) => r.key === 'patient_files').count >= 1);
});

test('the job turns old pictures into WebP and never touches PDFs; nothing is tried twice', async () => {
  const a = app.agent(); await a.login(mail('root'));
  const page = await a.get('/admin/images');
  const r = await a.post('/admin/images/start', { _csrf: a.csrf(page.text) });
  assert.equal(r.status, 302);
  await svc.wait();
  const st = svc.status();
  assert.equal(st.running, false);
  assert.ok(st.done >= 3);

  const m = await knex('clinic_media').where({ id: mediaId }).first();
  assert.equal(m.mime, 'image/webp');
  assert.equal(opt.kindOf(m.data), 'webp');
  assert.equal(m.size, m.data.length);
  assert.deepEqual([m.width, m.height], [2048, 983]);
  assert.notEqual(m.sha, 'aaaaaaaaaaaaaaaa'); // a new address, so browsers fetch the new file

  const f = await knex('patient_files').where({ id: fileId }).first();
  assert.equal(f.mime, 'image/webp');
  assert.equal(f.name, 'xray.webp');
  assert.equal(f.size, f.data.length);
  const pdf = await knex('patient_files').where({ id: pdfId }).first();
  assert.equal(pdf.mime, 'application/pdf');
  assert.ok(pdf.data.equals(PDF));

  const b = await knex('businesses').where({ id: bid }).first('logo', 'logo_mime', 'logo_version');
  assert.equal(b.logo_mime, 'image/webp');
  assert.equal(b.logo_version, logoBefore.logo_version + 1);
  assert.ok((await opt.toPng(b.logo)).length > 0); // PDFs still get it as PNG

  const log = await knex('image_compress_log').where({ target: 'patient_files', row_id: fileId });
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'done');
  assert.ok(log[0].bytes_after < log[0].bytes_before);
  assert.equal((await svc.scan()).reduce((s, x) => s + x.count, 0), 0);
  assert.equal(await svc.start({ userId: null }), false); // nothing left
  assert.ok(await knex('audit_logs').where({ action: 'platform.images_compressed' }).first());
  const after = await a.get('/admin/images');
  assert.equal(after.status, 200);
  const json = JSON.parse((await a.get('/admin/images/status')).text);
  assert.ok(json.done.count >= 3);
});
