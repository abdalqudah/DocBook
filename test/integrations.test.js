// Google Sheets export and the clinic media library (worker: integrations), against the test database.
// Google is never contacted: the Apps Script web app is a local fake HTTP server (POST → 302 → GET, like
// script.google.com) and the OAuth/Sheets calls go to a stubbed fetch.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const secrets = require('../src/core/secrets');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const sheets = require('../src/modules/integrations/sheets.service');
const media = require('../src/modules/integrations/media.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let A; let B; let server; let base; let googleRowBefore;

const PNG_2x2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYGD4z8DAwMDAwMDAAAANBAEB8yJyWQAAAABJRU5ErkJggg==', 'base64');
const GIF_1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function clinic(email, name, slug) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug });
  businesses.forget(businessId);
  return { businessId, userId, email, permissions: await rbac.getUserPermissions(businessId, userId), ip: '127.0.0.1', slug };
}

async function seed(c) {
  const [doctorId] = await knex('doctors').insert({ business_id: c.businessId, full_name: 'د. سامر', full_name_en: 'Dr Samer', slot_duration_minutes: 30, consultation_fee: 20, base_salary: 900, is_active: true, working_hours: '{}' });
  const [patientId] = await knex('patients').insert({
    business_id: c.businessId, full_name: 'سارة خالد', phone: '0791112223', gender: 'female', date_of_birth: '1990-05-17',
    allergies: 'Penicillin-SECRET', chronic_conditions: 'Asthma-SECRET', notes: 'Private note-SECRET', national_id: '9990001112',
  });
  await knex('appointments').insert({
    business_id: c.businessId, doctor_id: doctorId, patient_id: patientId, patient_name: 'سارة خالد', patient_phone: '0791112223',
    appointment_date: '2026-09-20', appointment_time: '09:30', duration_minutes: 30, status: 'completed', appointment_type: 'in_person', source: 'staff',
    amount_due: 25, payment_status: 'paid', notes: 'Chest pain-SECRET',
  });
  await knex('invoices').insert({ business_id: c.businessId, invoice_number: 1, doctor_id: doctorId, patient_id: patientId, doctor_name: 'د. سامر', service_name: 'كشفية', patient_name: 'سارة خالد', amount: 25, subtotal: 25, payment_method: 'cash', created_at: new Date('2026-09-20T08:00:00Z') });
  await knex('expenses').insert({ business_id: c.businessId, date: '2026-09-10', category: 'rent', title: '=HYPERLINK("x")', amount: 300, payment_method: 'bank_transfer' });
  await knex('payroll_payments').insert({ business_id: c.businessId, doctor_id: doctorId, period: '2026-08', base_salary: 900, commission: 0, bonuses: 0, deductions: 0, advances: 0, net_pay: 900, payment_method: 'bank_transfer', paid_at: new Date() });
}

/** Cookie + CSRF aware client for the access-control checks. */
function client() {
  const jar = {};
  let csrf = '';
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => { for (const h of res.headers.getSetCookie()) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } };
  const read = async (res) => { store(res); const text = await res.text(); const m = text.match(/name="csrf-token" content="([^"]+)"/); if (m) csrf = m[1]; return { status: res.status, location: res.headers.get('location'), text, headers: res.headers }; };
  return {
    get: async (path) => read(await fetch(base + path, { headers: { cookie: cookie() }, redirect: 'manual' })),
    post: async (path, data = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...data })) [].concat(v).forEach((x) => body.append(k, x));
      return read(await fetch(base + path, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' }));
    },
    upload: async (path, file, name, type) => {
      const fd = new FormData();
      fd.append('_csrf', csrf);
      fd.append('files', new Blob([file], { type }), name);
      return read(await fetch(base + path, { method: 'POST', headers: { cookie: cookie(), accept: 'application/json' }, body: fd, redirect: 'manual' }));
    },
  };
}
async function login(email) {
  const c = client();
  await c.get('/login?lang=en');
  const r = await c.post('/login', { email, password: 'Passw0rd!x' });
  assert.equal(r.status, 302, 'signed in');
  await c.get('/app/settings/account?lang=en');
  return c;
}
async function staff(c, roleKey, email) {
  const id = await knex.transaction((trx) => auth.createUser(trx, { name: roleKey, email, password: 'Passw0rd!x' }));
  const role = await knex('roles').where({ business_id: c.businessId, key: roleKey }).first('id');
  await knex('memberships').insert({ business_id: c.businessId, user_id: id, role_id: role.id, status: 'active' });
  return email;
}

/** A fake Apps Script web app: checks the secret, keeps the tabs in memory, answers through a redirect. */
function fakeWebApp(secret, { html = false } = {}) {
  const tabs = {}; const results = {}; const calls = []; let n = 0;
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/echo/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(results[req.url.slice(6)])); }
    let body = '';
    req.on('data', (d) => { body += d; });
    return req.on('end', () => {
      if (html) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><html><body>Sign in - Google Accounts</body></html>'); }
      const b = JSON.parse(body);
      calls.push({ action: b.action, tab: b.tab, mode: b.mode, rows: b.rows ? b.rows.length : 0, part: b.part, parts: b.parts, bytes: Buffer.byteLength(body) });
      let out;
      if (b.secret !== secret) out = { ok: false, error: 'unauthorized' };
      else if (b.action === 'ping') out = { ok: true, spreadsheet: 'Clinic backup' };
      else {
        if (b.mode === 'replace') tabs[b.tab] = [b.header];
        tabs[b.tab].push(...b.rows);
        out = { ok: true, written: b.rows.length };
      }
      n += 1; results[n] = out;
      res.writeHead(302, { location: `/echo/${n}` });
      return res.end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, tabs, calls, url: `http://127.0.0.1:${srv.address().port}/macros/s/test/exec` })));
}

/** Stubbed fetch for Google: records requests and answers from a handler. */
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? String(init.body) : '' };
    calls.push(call);
    const [status, json] = await handler(call);
    return { status, text: async () => (json === undefined ? '' : JSON.stringify(json)) };
  };
  return { fn, calls };
}

test.before(async () => {
  // Other suites may be migrating the shared test database at the same moment: wait for their lock.
  for (let i = 0; ; i += 1) {
    try { await knex.migrate.latest(); break; } catch (e) { if (!/locked/i.test(e.message) || i > 60) throw e; await new Promise((r) => { setTimeout(r, 3000); }); } // eslint-disable-line no-await-in-loop
  }
  cache.forgetPrefix('');
  A = await clinic(`owner-a${tag}@integ.test`, 'عيادة الأمل', `integ-a-${tag}`.slice(0, 40));
  B = await clinic(`owner-b${tag}@integ.test`, 'Clinic B', `integ-b-${tag}`.slice(0, 40));
  await seed(A);
  googleRowBefore = await knex('platform_settings').where({ key: 'google' }).first();
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  sheets.setTransport(null);
  delete process.env.INTEGRATIONS_ALLOW_PRIVATE;
  if (googleRowBefore) await knex('platform_settings').where({ key: 'google' }).update({ value: googleRowBefore.value });
  else await knex('platform_settings').where({ key: 'google' }).del();
  cache.forgetPrefix('');
  if (server) server.close();
  await knex.destroy();
});

// ---------------------------------------------------------------- media validation
test('media: files are recognised by their bytes; SVG, disguised and oversized files are refused', () => {
  assert.deepEqual(media.inspect(PNG_2x2), { mime: 'image/png', size: PNG_2x2.length, width: 2, height: 2 });
  assert.equal(media.inspect(GIF_1x1).mime, 'image/gif');
  assert.equal(media.inspect(GIF_1x1).width, 1);
  const pdf = media.inspect(PDF);
  assert.equal(pdf.mime, 'application/pdf');
  assert.equal(pdf.width, null);
  assert.throws(() => media.inspect(SVG), (e) => e.code === 'MEDIA_SVG');
  assert.throws(() => media.inspect(Buffer.from('<svg viewBox="0 0 1 1"></svg>                 ')), (e) => e.code === 'MEDIA_SVG');
  assert.throws(() => media.inspect(Buffer.from('MZ\x90\x00 definitely not an image at all')), (e) => e.code === 'MEDIA_TYPE');
  assert.throws(() => media.inspect(Buffer.alloc(0)), (e) => e.code === 'MEDIA_EMPTY');
  const big = Buffer.concat([PNG_2x2, Buffer.alloc(media.MAX_BYTES)]);
  assert.throws(() => media.inspect(big), (e) => e.code === 'MEDIA_TOO_BIG');
});

test('media: upload, clinic page usage, public serving and delete protection', async () => {
  const ctxA = { businessId: A.businessId, userId: A.userId };
  const img = await media.upload(ctxA, { buffer: PNG_2x2, originalname: 'front<script>.png' }, { folder: 'Clinic / photos', alt_ar: 'واجهة', alt_en: 'Front' });
  assert.equal(img.is_public, false);
  assert.ok(!/[<>]/.test(img.name));
  assert.equal(img.folder, 'Clinic - photos');
  const pdf = await media.upload(ctxA, { buffer: PDF, originalname: 'prices.pdf' }, { is_public: '1' });
  assert.equal(pdf.is_public, false, 'PDFs are never public');

  // Private images are not served publicly.
  assert.equal(await media.publicFile(A.slug, img.id), null);
  // The clinic page accepts images only, from the same clinic.
  await assert.rejects(media.setPageMedia(ctxA, { cover_media_id: String(pdf.id) }), (e) => e.code === 'MEDIA_NOT_IMAGE');
  const other = await media.upload({ businessId: B.businessId, userId: B.userId }, { buffer: PNG_2x2, originalname: 'b.png' }, {});
  await assert.rejects(media.setPageMedia(ctxA, { gallery_media_ids: [String(other.id)] }), (e) => e.code === 'MEDIA_NOT_IMAGE');

  await media.setPageMedia(ctxA, { cover_media_id: String(img.id), gallery_media_ids: [String(img.id)] });
  const page = await media.pageMedia(A.businessId);
  assert.equal(page.cover.id, img.id);
  assert.equal(page.gallery.length, 0, 'the cover is not repeated in the gallery');
  assert.equal((await media.get(A.businessId, img.id)).is_public, true, 'chosen images become public');
  assert.ok(await media.publicFile(A.slug, img.id));
  assert.equal(await media.publicFile(B.slug, img.id), null, 'not under another clinic');
  const pub = await media.publicPage({ id: A.businessId, slug: A.slug }, 'en');
  assert.equal(pub.cover.alt, 'Front');
  assert.match(pub.cover.url, new RegExp(`^/m/${A.slug}/${img.id}\\?v=`));

  // In use: cannot become private, delete needs confirmation.
  await assert.rejects(media.update(ctxA, img.id, { is_public: '0' }), (e) => e.code === 'MEDIA_PUBLIC_IN_USE');
  await assert.rejects(media.remove(ctxA, img.id), (e) => e.code === 'MEDIA_IN_USE' && e.details.usages[0] === 'portal.cover');
  await media.remove(ctxA, img.id, { force: true });
  assert.equal((await media.pageMedia(A.businessId)).cover, null);
  const logs = await knex('audit_logs').where({ business_id: A.businessId }).whereIn('action', ['media.uploaded', 'media.clinic_page_updated', 'media.deleted']).pluck('action');
  assert.ok(logs.includes('media.uploaded') && logs.includes('media.clinic_page_updated') && logs.includes('media.deleted'));
});

// ---------------------------------------------------------------- sheet payload
test('media: doctor photo — library images of the same clinic only, made public, tracked and cleared', async () => {
  const ctxA = { businessId: A.businessId, userId: A.userId };
  const [doctorId] = await knex('doctors').insert({ business_id: A.businessId, full_name: 'د. صورة', slot_duration_minutes: 30, is_active: true, working_hours: '{}' });
  const img = await media.upload(ctxA, { buffer: PNG_2x2, originalname: 'doctor.png' }, {});
  const pdf = await media.upload(ctxA, { buffer: PDF, originalname: 'cv.pdf' }, {});
  const foreign = await media.upload({ businessId: B.businessId, userId: B.userId }, { buffer: PNG_2x2, originalname: 'x.png' }, {});
  await assert.rejects(media.setDoctorPhoto(ctxA, doctorId, pdf.id), (e) => e.code === 'MEDIA_NOT_IMAGE');
  await assert.rejects(media.setDoctorPhoto(ctxA, doctorId, foreign.id), (e) => e.code === 'MEDIA_NOT_IMAGE');
  // Another clinic cannot set a photo on this clinic's doctor.
  assert.equal(await media.setDoctorPhoto({ businessId: B.businessId, userId: B.userId }, doctorId, foreign.id), null);

  await media.setDoctorPhoto(ctxA, doctorId, String(img.id));
  assert.equal((await knex('doctors').where({ id: doctorId }).first('photo_media_id')).photo_media_id, img.id);
  assert.equal((await media.get(A.businessId, img.id)).is_public, true, 'the clinic page shows it, so it becomes public');
  assert.deepEqual((await media.usages(A.businessId, img.id)).map((u) => u.context), ['doctor.photo']);
  assert.ok((await media.doctorPhotos(A.businessId, [doctorId]))[doctorId].url.startsWith(`/app/media/${img.id}`));
  assert.ok((await media.publicDoctorPhotos({ id: A.businessId, slug: A.slug }))[doctorId].startsWith(`/m/${A.slug}/${img.id}`));
  await assert.rejects(media.update(ctxA, img.id, { is_public: '' }), (e) => e.code === 'MEDIA_PUBLIC_IN_USE');

  await media.setDoctorPhoto(ctxA, doctorId, '');
  assert.equal((await knex('doctors').where({ id: doctorId }).first('photo_media_id')).photo_media_id, null);
  assert.equal((await media.usages(A.businessId, img.id)).length, 0);
  // Deleting a library image that is a doctor's photo clears the photo.
  await media.setDoctorPhoto(ctxA, doctorId, img.id);
  await media.remove(ctxA, img.id, { force: true });
  assert.equal((await knex('doctors').where({ id: doctorId }).first('photo_media_id')).photo_media_id, null);
});

test('sheets: payload has translated headers, no clinical fields, and no patients without the acknowledgement', async () => {
  const opts = { businessId: A.businessId, timezone: 'Asia/Amman', today: '2026-09-30', monthsBack: 12 };
  const noPatients = await sheets.buildTabs({ ...opts, tabs: sheets.TABS, locale: 'en', includePatients: false });
  const keys = noPatients.map((t) => t.key);
  assert.ok(!keys.includes('patients'), 'patients tab needs the acknowledgement');
  assert.ok(!keys.includes('staff_salaries') || sheets.STAFF_SALARY_TABLES.length, 'staff salaries only when the table exists');
  const appts = noPatients.find((t) => t.key === 'appointments');
  assert.deepEqual(appts.header, ['No.', 'Date', 'Time', 'Minutes', 'Doctor', 'Service', 'Type', 'Status', 'Booked via', 'Amount due', 'Payment']);
  assert.equal(appts.title, 'Appointments');
  assert.equal(appts.rows[0][4], 'Dr Samer');
  assert.equal(appts.rows[0][7], 'Completed');
  const all = JSON.stringify(noPatients);
  assert.ok(!all.includes('سارة خالد'), 'no patient names in any tab without the acknowledgement');
  assert.ok(!all.includes('SECRET'), 'no clinical notes, allergies or conditions');
  for (const t of noPatients) for (const r of t.rows) assert.equal(r.length, t.header.length, `${t.key}: every row matches the header`);

  const withPatients = await sheets.buildTabs({ ...opts, tabs: sheets.TABS, locale: 'ar', includePatients: true });
  const p = withPatients.find((t) => t.key === 'patients');
  assert.equal(p.title, 'المرضى');
  assert.deepEqual(p.header, ['رقم الملف', 'المريض', 'الهاتف', 'البريد الإلكتروني', 'الجنس', 'تاريخ الميلاد', 'شركة التأمين', 'تاريخ التسجيل']);
  assert.equal(p.rows[0][1], 'سارة خالد');
  assert.equal(p.rows[0][4], 'أنثى');
  const everything = JSON.stringify(withPatients);
  assert.ok(!everything.includes('SECRET') && !everything.includes('9990001112'), 'never clinical fields or ID numbers');
  assert.ok(withPatients.find((t) => t.key === 'appointments').header.includes('المريض'));
  const summary = withPatients.find((t) => t.key === 'summary');
  const sep = summary.rows.find((r) => r[0] === '2026-09');
  assert.deepEqual(sep.slice(1, 3), [25, 300]);

  // The period applies: nothing before it.
  const short = await sheets.buildTabs({ ...opts, monthsBack: 3, today: '2027-06-30', tabs: ['appointments', 'expenses'], locale: 'en' });
  assert.equal(short.find((t) => t.key === 'appointments').rows.length, 0);
});

test('sheets: including patients requires the acknowledgement, recorded once', async () => {
  const ctx = { businessId: A.businessId, userId: A.userId };
  await assert.rejects(sheets.saveOptions(ctx, { tabs: ['summary', 'patients'], months_back: '12', sheet_locale: 'ar' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.patients_ack));
  await sheets.saveOptions(ctx, { tabs: ['summary', 'patients'], months_back: '12', sheet_locale: 'ar', patients_ack: '1' });
  let cfg = await sheets.get(A.businessId);
  assert.equal(cfg.include_patients, true);
  assert.equal(cfg.patients_ack_by, A.userId);
  await sheets.saveOptions(ctx, { tabs: ['summary', 'patients'], months_back: '6', sheet_locale: 'en' }); // already acknowledged
  cfg = await sheets.get(A.businessId);
  assert.equal(cfg.months_back, 6);
  await sheets.saveOptions(ctx, { tabs: ['summary'], months_back: '6', sheet_locale: 'en' });
  cfg = await sheets.get(A.businessId);
  assert.equal(cfg.include_patients, false);
  assert.equal(cfg.patients_ack_at, null, 'turning patients off forgets the acknowledgement');
  await assert.rejects(sheets.saveOptions(ctx, { tabs: ['nope'], months_back: '5', sheet_locale: 'fr' }), (e) => Boolean(e.details.tabs && e.details.months_back && e.details.sheet_locale));
});

// ---------------------------------------------------------------- Apps Script web app
test('webhook: only Apps Script https addresses unless private addresses are explicitly allowed', () => {
  delete process.env.INTEGRATIONS_ALLOW_PRIVATE;
  assert.equal(sheets.checkWebhookUrl('https://script.google.com/macros/s/AKfycbx1234567890abc/exec'), 'https://script.google.com/macros/s/AKfycbx1234567890abc/exec');
  for (const bad of ['http://script.google.com/macros/s/AKfycbx1234567890abc/exec', 'https://evil.example.com/macros/s/AKfycbx1234567890abc/exec', 'https://127.0.0.1/x', 'https://script.google.com/other', 'not a url']) {
    assert.throws(() => sheets.checkWebhookUrl(bad), (e) => e.code === 'VALIDATION_FAILED', bad);
  }
});

test('webhook: rows are chunked by count and size', () => {
  const rows = Array.from({ length: 4500 }, (_, i) => [i, 'x']);
  const chunks = sheets.chunkRows(rows);
  assert.deepEqual(chunks.map((c) => c.length), [2000, 2000, 500]);
  const wide = Array.from({ length: 10 }, () => ['y'.repeat(400)]);
  assert.ok(sheets.chunkRows(wide, { maxRows: 100, maxBytes: 1000 }).every((c) => c.length <= 2));
  assert.deepEqual(sheets.chunkRows([]), [[]], 'an empty tab still sends its header');
});

test('webhook: export to a fake web app — secret, redirect, chunking, errors', async () => {
  process.env.INTEGRATIONS_ALLOW_PRIVATE = 'true';
  sheets.setTransport(null);
  const ctx = { businessId: A.businessId, userId: A.userId, ip: '127.0.0.1' };
  await assert.rejects(sheets.saveWebhook(ctx, 'https://script.google.com/macros/s/AKfycbx1234567890abc/exec'), (e) => e.code === 'GSHEETS_NO_SECRET');
  const secret = await sheets.startWebhook(ctx);
  assert.match(sheets.appsScript(secret), new RegExp(`var SECRET = '${secret}'`));
  assert.match(sheets.appsScript(secret), /function cell\(v\)/, 'the script writes formula-like text as plain text');
  const cfgRow = await knex('sheet_sync_settings').where({ business_id: A.businessId }).first();
  assert.ok(!String(cfgRow.webhook_secret_enc).includes(secret), 'secret stored encrypted');

  const app = await fakeWebApp(secret);
  try {
    const t = await sheets.saveWebhook(ctx, app.url);
    assert.equal(t.ok, true);
    assert.equal(t.spreadsheet, 'Clinic backup');
    await sheets.saveOptions(ctx, { tabs: ['summary', 'appointments', 'expenses', 'staff_salaries'], months_back: '0', sheet_locale: 'en' });
    const r = await sheets.run(A.businessId, { trigger: 'manual', userId: A.userId });
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.deepEqual(Object.keys(app.tabs).sort(), ['Appointments', 'Expenses', 'Summary']);
    assert.equal(app.tabs.Expenses[1][1], 'Rent');
    assert.equal(app.tabs.Expenses[1][2], '=HYPERLINK("x")', 'sent as data; the script neutralises it');
    assert.ok(app.calls.filter((c) => c.action === 'write').every((c) => c.mode === 'replace'));
    const run = await knex('sheet_sync_runs').where({ id: r.id }).first();
    assert.equal(run.status, 'ok');
    assert.equal(run.method, 'webhook');
    assert.ok(await knex('audit_logs').where({ business_id: A.businessId, action: 'integrations.sheets_exported' }).first());

    // Big tab: several requests, the first replaces, the rest append, all rows arrive in order.
    const rows = Array.from({ length: sheets.HOOK_CHUNK_ROWS * 2 + 7 }, (_, i) => [i, `row ${i}`]);
    app.calls.length = 0;
    const parts = await sheets.writeTabHook(app.url, secret, { key: 'x', title: 'Big', header: ['n', 'label'], rows }, false);
    assert.equal(parts, 3);
    assert.deepEqual(app.calls.map((c) => c.mode), ['replace', 'append', 'append']);
    assert.equal(app.tabs.Big.length, rows.length + 1);
    assert.equal(app.tabs.Big[rows.length][0], rows.length - 1);

    // Wrong secret → clear error, run logged as failed (nothing faked).
    await knex('sheet_sync_settings').where({ business_id: A.businessId }).update({ webhook_secret_enc: secrets.encrypt('wrong-secret-value') });
    const bad = await sheets.run(A.businessId, { trigger: 'manual' });
    assert.equal(bad.status, 'failed');
    assert.match(bad.error, /^GSHEETS_WEBHOOK_SECRET:/);
    assert.equal((await sheets.get(A.businessId)).last_status, 'failed');
  } finally { app.srv.close(); }

  const signIn = await fakeWebApp(secret, { html: true });
  try {
    await assert.rejects(sheets.hookPost(signIn.url, { secret, action: 'ping' }), (e) => e.code === 'GSHEETS_WEBHOOK_ACCESS');
  } finally { signIn.srv.close(); }
  await assert.rejects(sheets.hookPost('http://127.0.0.1:1/macros/s/x/exec', { secret, action: 'ping' }), (e) => e.code === 'GSHEETS_WEBHOOK_NETWORK');
  delete process.env.INTEGRATIONS_ALLOW_PRIVATE;
  await assert.rejects(sheets.hookPost('https://127.0.0.1/macros/s/x/exec', { secret, action: 'ping' }), (e) => e.code === 'GSHEETS_WEBHOOK_BLOCKED');
  await sheets.disconnect({ businessId: A.businessId, userId: A.userId });
  const after = await knex('sheet_sync_settings').where({ business_id: A.businessId }).first();
  assert.equal(after.webhook_url_enc, null);
  assert.equal(after.webhook_secret_enc, null);
  await assert.rejects(sheets.run(A.businessId), (e) => e.code === 'GSHEETS_NOT_CONNECTED');
});

// ---------------------------------------------------------------- Google account (OAuth) with stubbed HTTP
test('oauth: consent URL, code exchange, token refresh, spreadsheet creation, revoked access', async () => {
  await knex('platform_settings').insert({ key: 'google', value: JSON.stringify({ enabled: false, client_id: 'test-client.apps.googleusercontent.com', secret_enc: secrets.encrypt('test-client-secret') }) })
    .onConflict('key').merge();
  cache.forgetPrefix('');
  const ctx = { businessId: B.businessId, userId: B.userId };
  const { url, pending } = await sheets.startOAuth();
  const u = new URL(url);
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), sheets.redirectUri());
  assert.match(sheets.redirectUri(), /\/app\/settings\/google-sheets\/callback$/);

  let refreshes = 0; let revoked = false;
  const created = [];
  const stub = stubFetch(async (call) => {
    if (call.url === sheets.GOOGLE.token) {
      const form = new URLSearchParams(call.body);
      if (form.get('grant_type') === 'authorization_code') {
        assert.equal(form.get('code_verifier'), pending.verifier);
        assert.equal(form.get('client_secret'), 'test-client-secret');
        return [200, { access_token: 'at-1', expires_in: 3599, refresh_token: 'rt-secret-1', scope: sheets.SCOPE, token_type: 'Bearer' }];
      }
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'rt-secret-1');
      if (revoked) return [400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }];
      refreshes += 1;
      return [200, { access_token: `at-r${refreshes}`, expires_in: 3599 }];
    }
    if (call.url.startsWith('https://www.googleapis.com/drive/v3/about')) return [200, { user: { emailAddress: 'clinic@example.com' } }];
    assert.match(call.headers.authorization, /^Bearer at-/);
    if (call.url === sheets.GOOGLE.sheets && call.method === 'POST') {
      const b = JSON.parse(call.body); created.push(b);
      return [200, { spreadsheetId: 'sheet-123', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-123/edit' }];
    }
    if (call.url.includes('values:batchClear')) return [200, { clearedRanges: [] }];
    if (call.url.includes('values:batchUpdate')) {
      const b = JSON.parse(call.body);
      assert.equal(b.valueInputOption, 'RAW', 'cells are never evaluated as formulas');
      return [200, { totalUpdatedRows: b.data[0].values.length }];
    }
    return [404, { error: { message: 'unexpected' } }];
  });
  sheets.setTransport({ fetch: stub.fn });

  await assert.rejects(sheets.finishOAuth(ctx, pending, { state: 'forged', code: 'abc' }), (e) => e.code === 'GSHEETS_STATE');
  const r = await sheets.finishOAuth(ctx, pending, { state: pending.state, code: 'auth-code' });
  assert.equal(r.email, 'clinic@example.com');
  const row = await knex('sheet_sync_settings').where({ business_id: B.businessId }).first();
  assert.equal(row.method, 'oauth');
  assert.ok(row.oauth_refresh_enc && !row.oauth_refresh_enc.includes('rt-secret-1'), 'refresh token stored encrypted');

  // Access token: cached from the exchange; a forced refresh uses the refresh token.
  assert.equal(await sheets.accessToken(B.businessId), 'at-1');
  assert.equal(await sheets.accessToken(B.businessId, { force: true }), 'at-r1');
  assert.equal(await sheets.accessToken(B.businessId), 'at-r1', 'refreshed token is cached');

  await sheets.saveOptions(ctx, { tabs: ['summary', 'invoices'], months_back: '12', sheet_locale: 'en' });
  const run = await sheets.run(B.businessId, { trigger: 'manual', userId: B.userId });
  assert.equal(run.status, 'ok', JSON.stringify(run));
  assert.equal(created.length, 1);
  assert.equal(created[0].properties.title, 'DocBook – Clinic B');
  assert.deepEqual(created[0].sheets.map((s) => s.properties.title), ['Summary', 'Invoices']);
  assert.equal(run.spreadsheetUrl, 'https://docs.google.com/spreadsheets/d/sheet-123/edit');
  assert.equal((await sheets.get(B.businessId)).spreadsheet_id, 'sheet-123');

  // Access removed in Google: the refresh fails with invalid_grant → token forgotten, clear message.
  revoked = true;
  cache.forgetPrefix('gsheets:');
  await assert.rejects(sheets.accessToken(B.businessId), (e) => e.code === 'GSHEETS_RECONNECT');
  const cfg = await sheets.get(B.businessId);
  assert.equal(cfg.hasRefresh, false);
  assert.equal(cfg.needsReconnect, true);
  await assert.rejects(sheets.run(B.businessId), (e) => e.code === 'GSHEETS_RECONNECT');

  // Google unreachable (this sandbox): the failure is reported, never a success.
  sheets.setTransport({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'); } });
  await knex('sheet_sync_settings').where({ business_id: B.businessId }).update({ oauth_refresh_enc: secrets.encrypt('rt-secret-1') });
  const offline = await sheets.run(B.businessId, { trigger: 'manual' });
  assert.equal(offline.status, 'failed');
  assert.match(offline.error, /^GSHEETS_NETWORK:/);
  sheets.setTransport(null);
});

// ---------------------------------------------------------------- access control (HTTP)
test('access: pages, APIs and files follow permissions and clinic boundaries', async () => {
  const nurse = await login(await staff(A, 'nurse', `nurse${tag}@integ.test`));
  for (const p of ['/app/settings/google-sheets', '/app/website/media', '/app/media/api']) {
    assert.equal((await nurse.get(p)).status, 403, p);
  }
  assert.equal((await nurse.get('/app/settings/media')).status, 301, 'old address redirects (the new one checks access)');
  assert.equal((await nurse.post('/app/settings/google-sheets/run')).status, 403);
  assert.equal((await nurse.post('/app/settings/media/page', { cover_media_id: '' })).status, 403);

  const accountant = await login(await staff(A, 'accountant', `acc${tag}@integ.test`));
  const perms = await rbac.getUserPermissions(A.businessId, (await knex('users').where({ email: `acc${tag}@integ.test` }).first('id')).id);
  const page = await accountant.get('/app/settings/google-sheets');
  if (perms.has('data.export') || perms.has('data.manage')) {
    assert.equal(page.status, 200);
    if (!perms.has('data.manage')) {
      assert.ok(!page.text.includes('action="/app/settings/google-sheets/options"'), 'no configuration without data.manage');
      assert.equal((await accountant.post('/app/settings/google-sheets/webhook/start')).status, 403);
    }
  } else assert.equal(page.status, 403);

  const owner = await login(A.email);
  assert.equal((await owner.get('/app/settings/google-sheets')).status, 200);
  const media1 = await owner.get('/app/website/media');
  assert.equal(media1.status, 200);
  const up = await owner.upload('/app/settings/media/upload', PNG_2x2, 'x.png', 'image/png');
  assert.equal(up.status, 200);
  const id = JSON.parse(up.text).data[0].id;
  const svg = await owner.upload('/app/settings/media/upload', SVG, 'x.svg', 'image/svg+xml');
  assert.equal(svg.status, 422);
  assert.equal(JSON.parse(svg.text).errors.length, 1);

  // Members read files with safe headers; another clinic and the public cannot.
  const f = await nurse.get(`/app/media/${id}`);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'image/png');
  assert.equal(f.headers.get('x-content-type-options'), 'nosniff');
  assert.match(f.headers.get('content-security-policy'), /default-src 'none'/);
  const ownerB = await login(B.email);
  assert.equal((await ownerB.get(`/app/media/${id}`)).status, 404);
  assert.equal((await fetch(`${base}/m/${A.slug}/${id}`)).status, 404, 'private image is not public');
  await owner.post(`/app/settings/media/${id}`, { name: 'x', is_public: '1', public_field: '1' });
  const sha = (await knex('clinic_media').where({ id }).first('sha')).sha;
  assert.equal((await fetch(`${base}/m/${A.slug}/${id}`)).status, 404, 'the number alone is not enough');
  const pub = await fetch(`${base}/m/${A.slug}/${id}?v=${sha}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal((await fetch(`${base}/m/${B.slug}/${id}?v=${sha}`)).status, 404);
});
