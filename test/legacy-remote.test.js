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
let captchaOn = false; // Clinica asks a math question at sign-in
let full = false; // the whole Clinica: patients list, a new patient's form and treatments, a calendar day

// A small stand-in for Clinica: a sign-in form with a hidden token, a cookie session, patient pages with file links.
let fake;
function fakeClinica() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const live = new Set();
  const signedIn = (req) => { const m = /sid=([a-z0-9]+)/.exec(req.headers.cookie || ''); return m && live.has(m[1]) ? m[1] : null; };
  let q = 0;
  const form0 = '<html><body><form action="/user/login" method="post" id="user-login"><input type="text" name="name"><input type="password" name="pass"><input type="hidden" name="form_build_id" value="fb-123">CAPTCHA<input type="submit" name="op" value="Log in"></form></body></html>';
  const captcha = () => { q += 1; return `<fieldset class="captcha"><legend>CAPTCHA</legend><div>This question is for testing whether or not you are a human visitor.</div><input type="hidden" name="captcha_sid" value="sid${q}"><input type="hidden" name="captcha_token" value="tok${q}"><div class="form-item"><label for="edit-captcha-response">Math question <span class="form-required">*</span></label><span class="field-prefix">${q * 10} + 0 =</span><input type="text" id="edit-captcha-response" name="captcha_response" value="" size="4"><div class="description">Solve this simple math problem and enter the result. E.g. for 1+3, enter 4.</div></div></fieldset>`; };
  const form = { toString: () => form0.replace('CAPTCHA', captchaOn ? captcha() : '') };
  app.get('/user/login', (req, res) => res.send(String(form)));
  app.post('/user/login', (req, res) => {
    hits.login += 1;
    const answered = !captchaOn || (req.body.captcha_sid === `sid${q}` && req.body.captcha_response === String(q * 10));
    if (req.body.name === 'owner' && req.body.pass === 's3cret' && req.body.form_build_id === 'fb-123' && req.body.op === 'Log in' && answered) {
      const sid = `s${hits.login}`; live.add(sid); res.set('Set-Cookie', `sid=${sid}; Path=/; HttpOnly`); return res.redirect(302, '/');
    }
    return res.send(String(form));
  });
  function guard0(req, res, next) { return signedIn(req) ? next() : res.redirect(302, '/user/login'); }
  let loggedOut = 0;
  app.get('/', (req, res) => res.send(signedIn(req) ? '<html><title>Dr Clinic</title><nav><a href="/patients?page=2">Patients</a><a href="/calendar">Calendar</a><a href="/dental/1001">سامي خالد</a><a href="/user/logout">Log out</a><a href="/patient/7/delete">x</a></nav></html>' : String(form)));
  app.get('/user/logout', (req, res) => { loggedOut += 1; res.redirect('/'); });
  app.get('/patient/:id/delete', (req, res) => { loggedOut += 100; res.send('deleted'); });
  app.get('/patients', guard0, (req, res) => res.send(full
    ? `<table><thead><tr><th>Patient Number</th><th>Name</th><th>Mobile</th><th>Tel. No</th><th>Group</th><th>Nationality</th><th>Operations</th></tr></thead><tbody>
       <tr><td>77</td><td><a href="/edit_patient/2001">ليلى &amp; سامي</a></td><td>962790000077</td><td></td><td>Abdali Hospital</td><td>Jordan</td><td><a href="/edit_patient/2001">Edit</a> <a href="/delete_patient/2001">Delete</a></td></tr>
       <tr><td></td><td><a href="/edit_patient/1001">مريض</a></td><td></td><td></td><td></td><td></td><td><a href="/edit_patient/1001">Edit</a></td></tr></tbody></table>`
    : '<table><tr><th>Name</th><th>Mobile</th></tr><tr><td>سامي خالد</td><td>0791234567</td></tr></table>'));
  app.get('/ncalendar', guard0, (req, res) => res.send(`<form><input name="date[date]" value="${String(req.query.date || '').replace(/[^\d-]/g, '')}"></form>` + (full && req.query.date === '2024-03-05'
    ? '<table><tr><th>Time</th><th>Patient Name</th><th>Patient Number</th><th>Mobile</th><th>Calendar</th><th>Doctor</th></tr><tr><td>10:30 am</td><td><a href="/dental/2001">ليلى</a></td><td>77</td><td>962790000077</td><td>Abdali Clinic</td><td></td></tr><tr><td>01:00 pm</td><td><a href="/dental/2001">ليلى</a></td><td>77</td><td></td><td>Mansour</td><td></td></tr></table>'
    : '<table><tr><th>Time</th><th>Patient Name</th><th>Patient Number</th><th>Mobile</th><th>Calendar</th><th>Doctor</th></tr></table>')));
  app.get('/calendar', guard0, (req, res) => res.send('<div id="cal"></div><script src="/js/fullcalendar.min.js?v=3"></script><script>$("#cal").fullCalendar({ events: "/calendar/events?doctor=5" }); $.ajax({ url: "/appointment/123/details" });</script>'));
  app.locals.loggedOut = () => loggedOut;
  const guard = (req, res, next) => {
    const sid = signedIn(req);
    if (!sid) return res.redirect(302, '/user/login');
    if (sessionsLeft <= 0) { live.delete(sid); sessionsLeft = Infinity; return res.redirect(302, '/user/login'); } // the session ends once
    sessionsLeft -= 1;
    return next();
  };
  app.get('/dental/:id', guard, (req, res, next) => {
    if (!(full && req.params.id === '2001')) return next();
    return res.send(`<form action="/dental/2001"><table><thead><tr><th>Select / Print</th><th>Date</th><th>Tooth</th><th>Description</th><th>Doctor</th><th>Price</th><th>Type</th><th>Status</th><th>Complete Date</th><th>Note</th><th>Referred by</th><th>Complete</th></tr></thead><tbody>
      <tr><td><input type="checkbox"></td><td>2024-03-05</td><td>16</td><td>Examination &nbsp;&nbsp; more...X<br>Chief Complaint<br>pain<br><br>View Notes</td><td>Faris Qudah</td><td>0.000</td><td>Payment</td><td>Complete</td><td>2024-03-05</td><td>check</td><td></td><td></td></tr>
      <tr><td><input type="checkbox"></td><td>2024-04-10</td><td>All Teeth</td><td>scaling and polishing</td><td>Faris Qudah</td><td>20.000</td><td>Payment</td><td>Complete</td><td>2024-04-10</td><td></td><td></td><td></td></tr></tbody></table></form>`);
  });
  app.get('/dental/:id', guard, (req, res) => {
    if (req.params.id !== '1001') return res.send('<html><table><tr><td>No files</td></tr></table></html>');
    return res.send(`<html><table>
      <tr><td><a href="/system/files/2022/2253/1001/%D8%B5%D9%88%D8%B1%D8%A9.png">صورة.png</a></td><td>2022-05-01</td></tr>
      <tr><td><a href='https://other.example/system/files/x.pdf'>elsewhere</a></td></tr>
      <tr><td><a href="/system/files/2021/2253/old.pdf">old.pdf</a></td></tr>
      <tr><td><a href="/system/files/2021/2253/gone.pdf">gone.pdf</a></td></tr></table></html>`);
  });
  app.get('/edit_patient/:id', guard, (req, res, next) => (full && req.params.id === '2001' ? res.send(`<form action="/edit_patient/2001" method="post">
      <input name="p_number" value="77"><input name="p_name" value="ليلى &amp; سامي"><input name="p_en_name" value="Laila"><input name="p_mobile_no" value="962790000077"><input name="p_tel_no" value="">
      <input name="p_dob[date]" value="1990-05-01"><input name="p_email" value="laila@example.com"><input type="checkbox" name="p_show_impoNote" value="1" checked>
      <select name="p_gender"><option value="">- Select -</option><option value="2" selected="selected">Female</option></select>
      <select name="p_nationality"><option value="">-</option><option value="JO" selected>Jordan</option></select>
      <textarea name="p_impoNote">حساسية بنسلين</textarea><textarea name="p_medical_history">ضغط</textarea><textarea name="p_general_note"></textarea></form>`) : next()));
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
  fake = fakeClinica();
  clinica = fake.listen(0);
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
  await remote.start(ctx, { baseUrl: base, username: 'owner', password: 's3cret', from: '2024-01-01', to: '2024-01-01' });
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
  await remote.start(ctx, { baseUrl: base, username: 'owner', password: 's3cret', from: '2024-01-01', to: '2024-01-01' });
  await remote.settle(ctx.businessId);
  const again = await remote.progress(ctx.businessId);
  assert.equal(again.downloaded, 0); assert.equal(again.skipped, 3);
  assert.equal(hits.files - before, 1, 'only the missing (404) file is asked for again');
});

test('a sign-in question (CAPTCHA): shown to the owner, who answers it; never answered here; asked again → the pull waits', async () => {
  captchaOn = true;
  const c2 = { ...ctx, businessId: (await knex('businesses').insert({ name: 'Captcha clinic', slug: `cap${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }))[0] };
  const [pid] = await knex('patients').insert({ business_id: c2.businessId, full_name: 'م', legacy_source: 'clinica', legacy_patient_id: '1001' });
  await knex('legacy_patients').insert({ business_id: c2.businessId, legacy_source: 'clinica', legacy_patient_id: '1001', patient_id: pid });
  // without an answer: nothing starts, the question is kept for the owner
  await assert.rejects(() => remote.start(c2, { baseUrl: base, username: 'owner', password: 's3cret' }));
  assert.equal(await remote.progress(c2.businessId), null);
  const opened = await remote.prepare(c2, { baseUrl: base });
  assert.match(opened.question, /^\d+ \+ 0 =$/);
  assert.deepEqual(remote.pendingQuestion(c2.businessId), { base, question: opened.question });
  // a wrong answer is refused (and a fresh question is ready)
  await assert.rejects(() => remote.start(c2, { baseUrl: base, username: 'owner', password: 's3cret', captcha: '1' }));
  const fresh = remote.pendingQuestion(c2.businessId);
  assert.ok(fresh && fresh.question && fresh.question !== opened.question);
  // the owner's answer: signed in, the pull runs
  const answer = String(Number(/^(\d+)/.exec(fresh.question)[1])); // what the owner reads and types
  sessionsLeft = 1; // Clinica ends the session mid-way: the new question needs the owner → the pull waits
  await remote.start(c2, { baseUrl: base, username: 'owner', password: 's3cret', captcha: answer, from: '2024-01-01', to: '2024-01-01' });
  await remote.settle(c2.businessId);
  const p = await remote.progress(c2.businessId);
  assert.equal(p.status, 'waiting'); assert.equal(p.waitingFor, 'LOGIN_FAILED');
  captchaOn = false; sessionsLeft = Infinity;
});

test('structure check: the shape of Clinica\'s pages, no patient data; nothing that signs out or deletes is opened', async () => {
  const c3 = { ...ctx, businessId: (await knex('businesses').insert({ name: 'Probe clinic', slug: `prb${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }))[0] };
  await knex('legacy_patients').insert({ business_id: c3.businessId, legacy_source: 'clinica', legacy_patient_id: '1001' });
  const r = await remote.probe(c3, { baseUrl: base, username: 'owner', password: 's3cret', from: '2024-01-01', to: '2024-01-01' });
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /سامي|0791234567|Dr Clinic|s3cret/, 'no names, phones, titles or password');
  const pages = r.pages.map((p) => p.page);
  assert.ok(pages.includes('/dental/{n}') && pages.includes('/edit_patient/{n}') && pages.includes('/patients?page=') && pages.includes('/calendar'));
  const cal = r.pages.find((p) => p.page === '/calendar');
  assert.ok(cal.feeds.includes('/calendar/events?doctor=') && cal.feeds.includes('/appointment/{n}/details') && cal.feeds.includes('js:fullCalendar'));
  assert.deepEqual(r.pages.find((p) => p.page === '/patients?page=').tables[0].headers, ['Name', 'Mobile']);
  assert.equal(fake.locals.loggedOut(), 0, 'sign-out / delete never opened');
  assert.equal(remote.probeReport(c3.businessId), r);
});

test('pull everything: new patients, empty details filled, missing treatments, calendar appointments — nothing changed or doubled', async () => {
  full = true; sessionsLeft = Infinity; captchaOn = false;
  const c4 = { ...ctx, businessId: (await knex('businesses').insert({ name: 'Full clinic', slug: `full${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }))[0] };
  const [fares] = await knex('doctors').insert({ business_id: c4.businessId, full_name: 'د. فارس القضاة', is_active: true, working_hours: '{}', slot_duration_minutes: 30 });
  const [abdali] = await knex('clinic_branches').insert({ business_id: c4.businessId, name: 'العبدلي' });
  // 1001 is here already, with a name the clinic typed (kept) and an empty e-mail
  const [p1] = await knex('patients').insert({ business_id: c4.businessId, full_name: 'اسم من العيادة', legacy_source: 'clinica', legacy_patient_id: '1001' });
  await knex('legacy_patients').insert({ business_id: c4.businessId, legacy_source: 'clinica', legacy_patient_id: '1001', patient_id: p1 });
  const run = async () => { await remote.start(c4, { baseUrl: base, username: 'owner', password: 's3cret', from: '2024-03-04', to: '2024-03-06' }); await remote.settle(c4.businessId); return remote.progress(c4.businessId); };
  let p = await run();
  assert.equal(p.status, 'completed_with_issues', JSON.stringify(p.errors)); // 1001's gone.pdf
  assert.deepEqual([p.newPatients, p.newTreatments, p.appointments.added, p.appointments.merged, p.appointments.days], [1, 2, 1, 1, 3]);
  const laila = await knex('patients').where({ business_id: c4.businessId, legacy_patient_id: '2001' }).first();
  assert.equal(laila.full_name, 'ليلى & سامي'); assert.equal(laila.name_en, 'Laila'); assert.equal(laila.gender, 'female'); assert.equal(laila.nationality, 'JO');
  assert.equal(laila.date_of_birth, '1990-05-01'); assert.equal(laila.email, 'laila@example.com'); assert.equal(laila.important_note, 'حساسية بنسلين'); assert.equal(laila.chronic_conditions, 'ضغط');
  assert.equal((await knex('patients').where({ id: p1 }).first()).full_name, 'اسم من العيادة', 'a name the clinic has is kept');
  const plan = await knex('dental_plan_items').where({ business_id: c4.businessId, patient_id: laila.id }).orderBy('id');
  assert.deepEqual(plan.map((i) => [i.procedure_name, i.doctor_id]), [['Examination', fares], ['scaling and polishing', fares]]);
  assert.match(plan[0].notes, /Chief Complaint: pain/);
  const appts = await knex('appointments').where({ business_id: c4.businessId, patient_id: laila.id }).orderBy(['appointment_date', 'appointment_time']);
  // 2024-03-05: the treatments' visit became the 10:30 Abdali appointment; the 13:00 one is added; 2024-04-10: its treatment visit
  assert.deepEqual(appts.map((a) => [a.appointment_date, a.appointment_time.slice(0, 5)]), [['2024-03-05', '10:30'], ['2024-03-05', '13:00'], ['2024-04-10', '09:00']]);
  assert.equal(appts[0].doctor_id, fares, 'the treatments\' doctor stays'); assert.match(appts[0].notes, /Abdali Clinic/);
  assert.equal(plan[0].appointment_id, appts[0].id);
  // tie the calendar "Abdali Clinic" to the branch: the next pull sets the branch where none is — and adds nothing
  const promote = require('../src/modules/legacy/promote.service'); // eslint-disable-line global-require
  // the calendar is listed on the Doctors page (seen by the pull); the owner ties it to the branch there
  const names = await promote.doctorNames(c4.businessId);
  const cal = names.groups.find((g) => g.name === 'Abdali Clinic');
  assert.ok(cal && cal.calendar);
  await promote.saveDoctorMap(c4, [], [{ key: cal.key, branch_id: String(abdali) }]);
  await promote.settle(c4.businessId);
  const before = { patients: await knex('patients').where({ business_id: c4.businessId }).count({ n: '*' }), plan: plan.length, appts: appts.length };
  p = await run();
  assert.deepEqual([p.newPatients, p.newTreatments, p.appointments.added, p.appointments.merged], [0, 0, 0, 0]);
  assert.deepEqual(await knex('patients').where({ business_id: c4.businessId }).count({ n: '*' }), before.patients);
  assert.equal((await knex('dental_plan_items').where({ business_id: c4.businessId, patient_id: laila.id })).length, before.plan);
  const again = await knex('appointments').where({ business_id: c4.businessId, patient_id: laila.id }).orderBy(['appointment_date', 'appointment_time']);
  assert.equal(again.length, before.appts);
  assert.equal(again[0].branch_id, abdali);
  full = false;
});

test('calendar: a page that is not the day asked for adds nothing', async () => {
  const cw = require('../src/modules/legacy/clinica-web'); // eslint-disable-line global-require
  assert.equal(cw.calendarDay('<table><tr><th>Time</th><th>Mansour</th><th>Abdali Clinic</th></tr><tr><td>10:00</td><td><a href="/dental/5">A</a></td><td></td></tr><tr><td>10:30</td><td></td><td><a href="/edit_patient/6">B</a> <a href="/dental/7">C</a></td></tr></table>').map((a) => [a.time, a.id, a.calendar]).join(';'),
    '10:00,5,Mansour;10:30,6,Abdali Clinic;10:30,7,Abdali Clinic', 'the day grid when there is no list');
  full = true;
  const c5 = { ...ctx, businessId: (await knex('businesses').insert({ name: 'Day clinic', slug: `day${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }))[0] };
  // Clinica ignoring ?date= (always today): stopped at once
  const real = fake._router.stack.find((l) => l.route && l.route.path === '/ncalendar');
  const handle = real.route.stack[real.route.stack.length - 1].handle;
  real.route.stack[real.route.stack.length - 1].handle = (req, res) => res.send('<form><input name="date[date]" value="2030-01-01"></form><table><tr><th>Time</th><th>Patient Name</th><th>Calendar</th></tr><tr><td>10:00</td><td><a href="/dental/2001">x</a></td><td>Mansour</td></tr></table>');
  await remote.start(c5, { baseUrl: base, username: 'owner', password: 's3cret', from: '2024-03-04', to: '2024-03-06' });
  await remote.settle(c5.businessId);
  real.route.stack[real.route.stack.length - 1].handle = handle;
  const p = await remote.progress(c5.businessId);
  assert.ok(p.errors.some((e) => e.error_code === 'CALENDAR_DAY_NOT_SHOWN'));
  assert.equal(p.appointments.added + p.appointments.merged, 0);
  assert.equal(Number((await knex('appointments').where({ business_id: c5.businessId }).where('external_uid', 'like', '%:a:cal:%').count({ n: '*' }))[0].n), 0);
  full = false;
});

test('calendar times: what the file import put at 09:00 takes the real time from the calendar — never a second appointment', async () => {
  const promote = require('../src/modules/legacy/promote.service'); // eslint-disable-line global-require
  const b = (await knex('businesses').insert({ name: 'Times clinic', slug: `tm${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }))[0];
  const [pid] = await knex('patients').insert({ business_id: b, full_name: 'Time Patient', phone: '0790001111', legacy_source: 'clinica', legacy_patient_id: 'tm1' });
  await knex('legacy_patients').insert({ business_id: b, legacy_source: 'clinica', legacy_patient_id: 'tm1', patient_id: pid });
  const base = { business_id: b, patient_id: pid, patient_name: 'Time Patient', appointment_time: '09:00', status: 'completed', appointment_type: 'in_person', source: 'import', payment_status: 'imported', external_source: 'clinica' };
  await knex('appointments').insert([
    { ...base, appointment_date: '2024-03-05', external_uid: 'clinica:tm1:v:2024-03-05:x' }, // the visit of that day's treatments
    { ...base, appointment_date: '2024-03-06', external_uid: 'clinica:tm1:a:77' }, // an appointment of the uploaded file, no time
  ]);
  const up = (date, time) => promote.upsertCalendarAppointment(knex, b, pid, { date, time, calendar: 'Mansour', name: 'Time Patient' }, { today: '2026-01-01' });
  assert.equal(await up('2024-03-05', '10:30 AM'), 'merged');
  assert.equal(await up('2024-03-06', '4:15 PM'), 'merged');
  assert.equal(await up('2024-03-05', '10:30 AM'), 'existing', 'read again: nothing new');
  const rows = await knex('appointments').where({ business_id: b }).orderBy('appointment_date').select('appointment_date', 'appointment_time', 'external_uid');
  assert.equal(rows.length, 2, 'no second appointment');
  assert.deepEqual(rows.map((r) => String(r.appointment_time).slice(0, 5)), ['10:30', '16:15']);
  assert.ok(rows.every((r) => r.external_uid.includes(':a:cal:')));
  // a second patient that day at another time is another appointment; 12:30 AM is just after midnight
  assert.equal(promote.timeOf('12:30 AM'), '00:30'); assert.equal(promote.timeOf('12:30 PM'), '12:30');
});

test('calendar rows without a Clinica id: matched by number, by phone however written, a family phone by name; else kept with name and mobile', async () => {
  const promote = require('../src/modules/legacy/promote.service'); // eslint-disable-line global-require
  const b = (await knex('businesses').insert({ name: 'Match clinic', slug: `mt${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }))[0];
  const mk = async (lid, name, mobile, number) => {
    const [pid] = await knex('patients').insert({ business_id: b, full_name: name, phone: mobile, legacy_source: 'clinica', legacy_patient_id: lid });
    await knex('legacy_patients').insert({ business_id: b, legacy_source: 'clinica', legacy_patient_id: lid, patient_id: pid, old_name: name, old_mobile: mobile, legacy_patient_number: number });
    return pid;
  };
  const sara = await mk('m1', 'سارة أحمد', '0791112233', '501');
  const ali = await mk('m2', 'علي محمود', '0795556677', '502');
  const huda = await mk('m3', 'هدى محمود', '0795556677', '503'); // same phone (family)
  const m = await remote.matcherFor({ id: `t${tag}`, business_id: b });
  const pid = (a) => { const r = m.find(a); return r ? r.patient_id : null; };
  assert.equal(pid({ number: '501', name: 'x' }), sara);
  assert.equal(pid({ mobile: '+962 79 111 2233', name: 'ساره احمد' }), sara, 'the same number written another way');
  assert.equal(pid({ mobile: '00962795556677', name: 'هدى محمود' }), huda, 'family phone: by name');
  assert.equal(pid({ mobile: '0795556677', name: 'علي محمود' }), ali);
  assert.equal(pid({ mobile: '0795556677', name: 'someone else' }), null, 'family phone, unknown name: not guessed');
  assert.equal(pid({ mobile: '0790000000', name: 'Walk In' }), null);
  // not matched: kept with its name and mobile, once
  const g = { date: '2024-04-01', time: '11:00', name: 'Walk In', mobile: '0790000000', calendar: 'Mansour' };
  assert.equal(await promote.upsertCalendarAppointment(knex, b, null, g, { today: '2026-01-01' }), 'new');
  assert.equal(await promote.upsertCalendarAppointment(knex, b, null, g, { today: '2026-01-01' }), 'existing');
  const row = await knex('appointments').where({ business_id: b, patient_name: 'Walk In' }).first();
  assert.equal(row.patient_id, null); assert.equal(row.patient_phone, '0790000000'); assert.equal(String(row.appointment_time).slice(0, 5), '11:00');
  // later matched to a file: that same appointment becomes theirs (not a second one)
  const walk = await mk('m4', 'Walk In', '0790000000', '504');
  await promote.upsertCalendarAppointment(knex, b, walk, g, { today: '2026-01-01' });
  const all = await knex('appointments').where({ business_id: b, appointment_date: '2024-04-01' });
  assert.equal(all.length, 1); assert.equal(all[0].patient_id, walk);
});

test('the Doctors page\'s calendar → branch choice moves the visits read earlier, and their patients', async () => {
  const promote = require('../src/modules/legacy/promote.service'); // eslint-disable-line global-require
  const b = (await knex('businesses').insert({ name: 'Branch move', slug: `bm${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }))[0];
  const [abdali] = await knex('clinic_branches').insert({ business_id: b, name: 'Abdali', is_active: true });
  const [pid] = await knex('patients').insert({ business_id: b, full_name: 'Moved Patient', legacy_source: 'clinica', legacy_patient_id: 'bm1' });
  await knex('legacy_patients').insert({ business_id: b, legacy_source: 'clinica', legacy_patient_id: 'bm1', patient_id: pid });
  const base = { business_id: b, patient_id: pid, patient_name: 'Moved Patient', status: 'completed', appointment_type: 'in_person', source: 'import', payment_status: 'imported', external_source: 'clinica', appointment_time: '10:00' };
  const [x] = await knex('appointments').insert({ ...base, appointment_date: '2024-02-01', notes: 'Clinica: Abdali Clinic', external_uid: 'clinica:bm1:a:cal:2024-02-01:10:00:aa' });
  const [y] = await knex('appointments').insert({ ...base, appointment_date: '2024-02-02', notes: 'Clinica: Mansour', external_uid: 'clinica:bm1:a:cal:2024-02-02:10:00:bb' });
  await knex('patient_branches').insert({ business_id: b, patient_id: pid, branch_key: 'main' });
  await knex('legacy_branch_map').insert({ business_id: b, legacy_source: 'clinica', group_key: promote.docKey('Abdali Clinic'), group_name: 'Abdali Clinic', branch_id: abdali });
  assert.equal(await promote.reapplyBranches(b), 1);
  assert.equal((await knex('appointments').where({ id: x }).first()).branch_id, abdali);
  assert.equal((await knex('appointments').where({ id: y }).first()).branch_id, null);
  assert.deepEqual((await knex('patient_branches').where({ patient_id: pid }).pluck('branch_key')).sort(), [String(abdali), 'main'].sort());
  assert.equal(await promote.reapplyBranches(b), 0, 'again: nothing to move');
});
