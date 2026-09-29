// Staff attendance: QR token rotation (10 s) and acceptance window (30 s), clinic binding, clock in/out toggle,
// QR-only rule, corrections with an audited reason, and the scan flow over HTTP (including another clinic's code).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const att = require('../src/modules/attendance/attendance.service');
const { publicBase } = require('../src/middleware/web');

let A; let B; let nurse;

async function clinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), timezone: 'Asia/Amman', today: scheduling.clinicNow('Asia/Amman').date, ip: '10.0.0.1', userAgent: 'test' };
}

async function member(c, email, roleKey) {
  const id = await knex.transaction((trx) => auth.createUser(trx, { name: `Staff ${roleKey}`, email, password: 'Passw0rd!x' }));
  const role = await knex('roles').where({ business_id: c.businessId, key: roleKey }).first('id');
  await knex('memberships').insert({ business_id: c.businessId, user_id: id, role_id: role.id, status: 'active' });
  await knex('users').where({ id }).update({ last_business_id: c.businessId });
  rbac.invalidate(c.businessId);
  return { ...c, userId: id, permissions: await rbac.getUserPermissions(c.businessId, id) };
}

test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  A = await clinic('owner@att-a.test', 'Clinic A');
  B = await clinic('owner@att-b.test', 'Clinic B');
  nurse = await member(A, 'nurse@att-a.test', 'nurse');
});

test.after(() => knex.destroy());

test('QR token changes every 10 seconds and is bound to the clinic', () => {
  const t0 = 1_800_000_000_000; // a step boundary (divisible by 10 000)
  const a = att.issueToken(A.businessId, t0);
  assert.equal(att.STEP_MS, 10_000);
  assert.equal(att.issueToken(A.businessId, t0 + 9_999).token, a.token, 'same code within the 10-second window');
  assert.notEqual(att.issueToken(A.businessId, t0 + 10_000).token, a.token, 'new code after 10 seconds');
  assert.equal(a.expiresIn, 10);
  assert.equal(att.issueToken(A.businessId, t0 + 7_500).expiresIn, 3);
  assert.notEqual(att.issueToken(B.businessId, t0).token.split('.')[2], a.token.split('.')[2], 'each clinic signs its own');
  // Changing the clinic id inside the token breaks the signature.
  const forged = a.token.replace(/^\d+\./, `${B.businessId}.`);
  assert.throws(() => att.verifyToken(forged, t0), { code: 'QR_INVALID' });
  assert.throws(() => att.verifyToken('garbage', t0), { code: 'QR_INVALID' });
});

test('a scanned code is accepted for up to 30 seconds, by several people', () => {
  const t0 = 1_800_000_000_000;
  const { token } = att.issueToken(A.businessId, t0);
  for (const dt of [0, 5_000, 12_000, 25_000, 29_999]) assert.equal(att.verifyToken(token, t0 + dt).businessId, A.businessId, `accepted after ${dt} ms`);
  // Many scans of the same code within the window all pass (no single use).
  for (let i = 0; i < 5; i += 1) assert.ok(att.verifyToken(token, t0 + 1_000));
  assert.throws(() => att.verifyToken(token, t0 + 30_000), { code: 'QR_EXPIRED' });
  assert.throws(() => att.verifyToken(token, t0 - 1), { code: 'QR_EXPIRED' }, 'a code from the future is refused');
});

test('the QR link uses the real address, and the SVG carries no fixed colours', async () => {
  const q = await att.currentQr(A.businessId, 'https://clinic.example.com/');
  assert.match(q.url, /^https:\/\/clinic\.example\.com\/app\/attendance\/scan\?t=\d+\.\d+\.[a-f0-9]{20}$/);
  assert.ok(q.svg.startsWith('<svg') && q.svg.includes('currentColor'));
  assert.doesNotMatch(q.svg, /#[0-9a-f]{6}/i);
  const req = (host, extra = {}) => ({ app: { enabled: () => false }, protocol: 'http', get: (h) => ({ host, ...extra })[h.toLowerCase()] });
  const saved = process.env.APP_URL;
  const savedCfg = require('../src/config').appUrl;
  try {
    process.env.APP_URL = 'http://localhost:3000';
    require('../src/config').appUrl = 'http://localhost:3000';
    assert.equal(publicBase(req('clinic.example.com')), 'http://clinic.example.com', 'localhost APP_URL: the opened address');
    assert.equal(publicBase(req('bad host"><')), 'http://localhost:3000', 'odd Host headers are ignored');
    process.env.APP_URL = 'https://docbook.example.org';
    require('../src/config').appUrl = 'https://docbook.example.org';
    assert.equal(publicBase(req('other.example.com')), 'https://docbook.example.org', 'a real APP_URL wins');
  } finally {
    if (saved === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved;
    require('../src/config').appUrl = savedCfg;
  }
});

test('clock in / clock out toggles on the open shift; a double tap does not undo it', async () => {
  const t0 = Date.now() - 3 * 3600_000;
  const r1 = await att.toggle(nurse, { method: 'qr', expect: 'in', now: t0 });
  assert.equal(r1.action, 'in');
  await assert.rejects(att.toggle(nurse, { method: 'button', expect: 'in', now: t0 + 1000 }), { code: 'ATTENDANCE_ALREADY_IN' });
  const r2 = await att.toggle(nurse, { method: 'button', expect: 'out', now: t0 + 2 * 3600_000 });
  assert.equal(r2.action, 'out');
  assert.equal(r2.id, r1.id);
  assert.equal(r2.minutes, 120);
  const row = await knex('attendance_records').where({ id: r1.id }).first();
  assert.equal(row.in_method, 'qr');
  assert.equal(row.out_method, 'button');
  assert.equal(row.in_ip, '10.0.0.1');
  assert.equal(row.business_id, A.businessId);
  const r3 = await att.toggle(nurse, { now: t0 + 2.5 * 3600_000 });
  assert.equal(r3.action, 'in', 'a second shift the same day');
  assert.notEqual(r3.id, r1.id);
  const month = await att.myMonth(nurse, row.work_date.slice(0, 7));
  const day = month.days.find((d) => d.date === row.work_date);
  assert.equal(day.shifts.length, 2);
  assert.equal(day.minutes, 120);
  // Not a member of clinic B.
  await assert.rejects(att.toggle({ ...nurse, businessId: B.businessId }), { code: 'ATTENDANCE_NOT_MEMBER' });
});

test('QR-only rule refuses the button but not the scan', async () => {
  await att.saveSettings(A, { qrOnly: true });
  const owner = { ...A };
  await assert.rejects(att.toggle(owner, { method: 'button' }), { code: 'ATTENDANCE_QR_ONLY' });
  const r = await att.toggle(owner, { method: 'qr' });
  assert.equal(r.action, 'in');
  await att.saveSettings(A, { qrOnly: false });
  const log = await knex('audit_logs').where({ business_id: A.businessId, action: 'attendance.settings_updated' });
  assert.equal(log.length, 2);
});

test('correction needs a reason, is audited, and stays inside the clinic', async () => {
  const [rec] = await att.records(nurse, { userId: nurse.userId });
  await assert.rejects(att.correct(A, rec.id, { work_date: rec.work_date, clock_in: '08:00', clock_out: '09:00', reason: ' ' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.reason));
  await assert.rejects(att.correct(B, rec.id, { work_date: rec.work_date, clock_in: '08:00', clock_out: '09:00', reason: 'x' }), { code: 'NOT_FOUND' });
  const yesterday = new Date(Date.now() - 86_400_000);
  const d = att.localDate('Asia/Amman', yesterday);
  await att.correct(A, rec.id, { work_date: d, clock_in: '22:00', clock_out: '06:30', reason: 'Night shift; forgot to clock out' });
  const row = await knex('attendance_records').where({ id: rec.id }).first();
  assert.equal(att.minutesOf(row), 510, 'a clock-out before the clock-in ends the next day');
  assert.equal(att.localTime('Asia/Amman', row.clock_in), '22:00');
  assert.equal(row.correction_reason, 'Night shift; forgot to clock out');
  assert.equal(row.corrected_by, A.userId);
  const log = await knex('audit_logs').where({ business_id: A.businessId, action: 'attendance.corrected', entity_id: String(rec.id) }).first();
  assert.ok(log);
  const nv = typeof log.new_values === 'string' ? JSON.parse(log.new_values) : log.new_values;
  const ov = typeof log.old_values === 'string' ? JSON.parse(log.old_values) : log.old_values;
  assert.equal(nv.reason, 'Night shift; forgot to clock out');
  assert.ok(ov.clock_in);
  await att.remove(A, rec.id);
  assert.equal(await knex('attendance_records').where({ id: rec.id }).first(), undefined);
  assert.ok(await knex('audit_logs').where({ business_id: A.businessId, action: 'attendance.deleted', entity_id: String(rec.id) }).first());
});

// ---------------------------------------------------------------- HTTP: scan flow
async function serve() {
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  const server = await new Promise((resolve) => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  const jar = {};
  const send = (method, path, form) => new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : '';
    const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), host: `127.0.0.1:${port}` };
    if (form) Object.assign(headers, { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) });
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      for (const h of res.headers['set-cookie'] || []) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      let text = ''; res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, text }));
    });
    r.on('error', reject); r.end(body);
  });
  const csrf = (html) => (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  return { server, get: (p) => send('GET', p), post: (p, f) => send('POST', p, f), csrf };
}

test('HTTP: scan → one tap clock in; another clinic\'s code is refused; sign-in comes first', async () => {
  const { server, get, post, csrf } = await serve();
  try {
    let r = await get(`/app/attendance/scan?t=${att.issueToken(A.businessId).token}`);
    assert.equal(r.status, 302);
    assert.equal(r.location, '/login', 'not signed in: login first');
    r = await get('/login');
    r = await post('/login', { _csrf: csrf(r.text), email: 'nurse@att-a.test', password: 'Passw0rd!x' });
    assert.equal(r.status, 302);
    r = await get(`/app/attendance/scan?t=${att.issueToken(B.businessId).token}`);
    assert.equal(r.status, 403, 'code of a clinic this account does not work at');
    r = await get('/app/attendance/scan?t=1.1.0123456789abcdef0123');
    assert.equal(r.status, 400);
    r = await get(`/app/attendance/scan?t=${att.issueToken(A.businessId).token}`);
    assert.equal(r.location, '/app/attendance/scan');
    r = await get('/app/attendance/scan');
    assert.equal(r.status, 200);
    const expect = (r.text.match(/name="expect" value="(\w+)"/) || [])[1];
    assert.ok(expect);
    r = await post('/app/attendance/scan', { _csrf: csrf(r.text), expect });
    assert.equal(r.status, 302);
    const last = await knex('attendance_records').where({ business_id: A.businessId, user_id: nurse.userId }).orderBy('id', 'desc').first();
    assert.equal(expect === 'in' ? last.in_method : last.out_method, 'qr');
    r = await get('/app/attendance/scan');
    assert.match(r.text, /scan-time/);
    // The ticket is used up.
    r = await post('/app/attendance/scan', { _csrf: csrf(r.text), expect });
    assert.equal(r.status, 410);
    // The nurse has no attendance.manage: no kiosk, no corrections.
    r = await get('/app/attendance/kiosk');
    assert.equal(r.status, 403);
    r = await post(`/app/attendance/records/${last.id}/delete`, { _csrf: csrf((await get('/app/attendance')).text) });
    assert.equal(r.status, 403);
  } finally {
    server.close();
  }
});
