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
  // 06:00 three clinic days ago (Amman, UTC+3): in the past and inside one clinic day whatever time the suite runs,
  // and clear of the days the correction (−2) and missed-shift (−1) tests use.
  const t0 = Date.parse(`${att.shiftDay(A.today, -3)}T06:00:00+03:00`);
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
  // Two days back: the night shift (22:00 → 06:30 next morning) is fully in the past at any hour of the run.
  const d = att.shiftDay(A.today, -2);
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

// ---------------------------------------------------------------- round 2: working hours, board, screens
const kiosks = require('../src/modules/attendance/kiosk.service');

test('working hours decide present / late / absent / not yet / day off; own hours win over the clinic hours', async () => {
  const s = await att.saveSettings(A, { workDays: ['sat', 'sun', 'mon', 'tue', 'wed', 'thu'], workStart: '09:00', workEnd: '17:00', grace: 10 });
  assert.deepEqual(s.workDays, ['sat', 'sun', 'mon', 'tue', 'wed', 'thu']);
  assert.equal(s.hasPlan, true);
  await assert.rejects(att.saveSettings(A, { workDays: [], workStart: '09:00', workEnd: 'x' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.work_end && e.details.work_days));
  const { planFor } = await att.planner(A.businessId, '2026-09-01', '2026-09-30');
  // 2026-09-25 is a Friday, 2026-09-26 a Saturday.
  assert.equal(planFor(nurse.userId, '2026-09-25'), 'off');
  assert.deepEqual(planFor(nurse.userId, '2026-09-26'), { start: '09:00', end: '17:00', minutes: 480, source: 'clinic' });
  const now = { date: '2026-09-30', minutes: 9 * 60 + 5 };
  const plan = planFor(nurse.userId, '2026-09-30');
  const shift = (inTime, minutes, out = true) => ({ inTime, minutes, clock_out: out ? new Date() : null });
  assert.equal(att.dayStatus(plan, [shift('09:08', 480)], '2026-09-30', now, 10).status, 'present', 'within the grace minutes');
  const late = att.dayStatus(plan, [shift('09:25', 400)], '2026-09-30', now, 10);
  assert.equal(late.status, 'late');
  assert.equal(late.lateMinutes, 25);
  assert.equal(att.dayStatus(plan, [shift('08:00', 600)], '2026-09-30', now, 10).overtime, 120);
  assert.equal(att.dayStatus(plan, [], '2026-09-30', now, 10).status, 'not_yet', 'before start + grace');
  assert.equal(att.dayStatus(plan, [], '2026-09-30', { date: '2026-09-30', minutes: 9 * 60 + 11 }, 10).status, 'absent');
  assert.equal(att.dayStatus(plan, [], '2026-09-29', now, 10).status, 'absent', 'a past working day');
  assert.equal(att.dayStatus(plan, [], '2026-09-29', now, 10, '2026-09-30').status, 'no_record', 'before tracking started: never an absence');
  assert.equal(s.planSince, A.today, 'tracking starts the day the hours are set');
  assert.equal(att.dayStatus('off', [], '2026-09-25', now, 10).status, 'off');
  assert.equal(att.dayStatus(null, [], '2026-09-29', now, 10).status, 'no_record', 'no plan: nothing is called absent');
  // Own hours (evening shift) replace the clinic hours; removing them brings the clinic hours back.
  await att.saveSchedule(A, nurse.userId, { days: ['sat', 'mon'], start: '16:00', end: '22:00' });
  const p2 = (await att.planner(A.businessId, '2026-09-26', '2026-09-27')).planFor;
  assert.deepEqual(p2(nurse.userId, '2026-09-26'), { start: '16:00', end: '22:00', minutes: 360, source: 'own' });
  assert.equal(p2(nurse.userId, '2026-09-27'), 'off');
  await assert.rejects(att.saveSchedule(B, nurse.userId, { days: ['sat'], start: '09:00', end: '10:00' }), { code: 'NOT_FOUND' }, 'not a member of clinic B');
  await att.removeSchedule(A, nurse.userId);
  assert.equal((await att.planner(A.businessId, '2026-09-26', '2026-09-26')).planFor(nurse.userId, '2026-09-26').source, 'clinic');
  assert.ok(await knex('audit_logs').where({ business_id: A.businessId, action: 'attendance.schedule_saved' }).first());
});

test('a manager adds a missed shift (reason required, audited, no overlap); board and monthly report count it', async () => {
  const d = att.shiftDay(A.today, -1);
  await assert.rejects(att.addManual(A, { user_id: nurse.userId, work_date: d, clock_in: '09:20', clock_out: '12:00', reason: '' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.reason));
  await assert.rejects(att.addManual(A, { user_id: B.userId, work_date: d, clock_in: '09:20', clock_out: '12:00', reason: 'x' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.user_id), 'only staff of this clinic');
  const id = await att.addManual(A, { user_id: nurse.userId, work_date: d, clock_in: '09:20', clock_out: '12:00', reason: 'Phone battery was empty' });
  await assert.rejects(att.addManual(A, { user_id: nurse.userId, work_date: d, clock_in: '11:00', clock_out: '13:00', reason: 'x' }), { code: 'ATTENDANCE_OVERLAP' });
  const row = await knex('attendance_records').where({ id }).first();
  assert.equal(row.in_method, 'manual');
  assert.equal(row.corrected_by, A.userId);
  assert.ok(await knex('audit_logs').where({ business_id: A.businessId, action: 'attendance.added', entity_id: String(id) }).first());
  const b = await att.board(A, d);
  const n = b.rows.find((p) => p.user_id === nurse.userId);
  assert.equal(n.worked, 160);
  assert.equal(n.firstIn, '09:20');
  if (att.DAY_KEYS[new Date(`${d}T00:00:00Z`).getUTCDay()] !== 'fri') {
    assert.equal(n.status, 'late');
    assert.equal(n.lateMinutes, 20);
  }
  assert.ok(b.rows.every((p) => p.status !== 'not_yet'), 'yesterday: nobody is "not in yet"');
  const rep = await att.monthReport(A, d.slice(0, 7));
  const rn = rep.rows.find((p) => p.user_id === nurse.userId);
  assert.ok(rn.worked >= 160);
  const sheet = await att.timesheet(A, nurse.userId, d.slice(0, 7));
  assert.equal(sheet.days.find((x) => x.date === d).shifts.length, 1);
  await assert.rejects(att.timesheet(B, nurse.userId, d.slice(0, 7)), { code: 'NOT_FOUND' });
  await att.remove(A, id);
});

test('door screens: secret link, new link, switch off, other clinic; same-network rule', async () => {
  const id = await kiosks.create(A, { name: 'Main entrance' });
  const k = await kiosks.get(A, id);
  await assert.rejects(kiosks.get(B, id), { code: 'NOT_FOUND' });
  const url = kiosks.displayUrl(k, 'http://clinic.test');
  const token = url.split('/kiosk/')[1];
  assert.match(url, /^http:\/\/clinic\.test\/kiosk\/[A-Za-z0-9_-]{20,}$/);
  assert.equal((await kiosks.byDisplayToken(token)).id, id);
  assert.notEqual(k.display_token_hash, token, 'the link is stored hashed');
  await kiosks.regenerate(A, id);
  assert.equal(await kiosks.byDisplayToken(token), null, 'a new link stops the old one');
  const fresh = await kiosks.get(A, id);
  const token2 = kiosks.displayUrl(fresh, 'x').split('/kiosk/')[1];
  await kiosks.update(A, id, { is_active: false });
  assert.equal(await kiosks.byDisplayToken(token2), null, 'switched off');
  await kiosks.update(A, id, { is_active: true });
  // Network: no screen on → nothing to compare with; then the screen reports from a public address.
  assert.deepEqual(await kiosks.networkCheck(A.businessId, '203.0.113.9'), { known: false, same: true });
  await kiosks.touch(await kiosks.get(A, id), '::ffff:198.51.100.7');
  assert.equal((await kiosks.networkCheck(A.businessId, '198.51.100.7')).same, true, 'same internet connection');
  assert.equal((await kiosks.networkCheck(A.businessId, '203.0.113.9')).same, false, 'another network');
  await kiosks.touch({ ...(await kiosks.get(A, id)), last_seen_at: null }, '127.0.0.1');
  assert.equal((await kiosks.networkCheck(A.businessId, '192.168.1.20')).same, true, 'DocBook on a clinic PC: phones on its Wi-Fi');
  assert.ok(await knex('audit_logs').where({ business_id: A.businessId, action: 'attendance.screen_new_link' }).first());
});

test('HTTP: door screen link works without signing in; scan while signed out → login → the scan still counts', async () => {
  const { server, get, post, csrf } = await serve();
  try {
    const [k] = await kiosks.list(A.businessId);
    const token = kiosks.displayUrl(k, 'http://x').split('/kiosk/')[1];
    let r = await get(`/kiosk/${token}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /data-kiosk-qr/);
    assert.match(r.text, /Clinic A/);
    assert.doesNotMatch(r.text, /\/app\/attendance\/screens/, 'no way into the app from the door screen');
    r = await get(`/kiosk/${token}/qr`);
    const j = JSON.parse(r.text);
    assert.ok(j.data.svg.startsWith('<svg'));
    assert.ok(j.data.expiresIn >= 1 && j.data.expiresIn <= 10);
    assert.ok(Array.isArray(j.data.feed));
    assert.equal((await get('/kiosk/not-a-real-token-000000000/qr')).status, 404);
    // Phone, not signed in: scans the code, signs in after the code has changed, and the scan still counts.
    const before = await knex('attendance_records').where({ business_id: A.businessId, user_id: nurse.userId }).count({ n: '*' }).first();
    const open = await att.openShift(A.businessId, nurse.userId);
    r = await get(`/app/attendance/scan?t=${att.issueToken(A.businessId).token}`);
    assert.equal(r.status, 302);
    assert.equal(r.location, '/login');
    r = await get('/login');
    r = await post('/login', { _csrf: csrf(r.text), email: 'nurse@att-a.test', password: 'Passw0rd!x' });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/app/attendance/scan?resume=1');
    r = await get(r.location);
    assert.equal(r.status, 200, 'the confirmation screen, not "scan again"');
    const expect = (r.text.match(/name="expect" value="(\w+)"/) || [])[1];
    assert.equal(expect, open ? 'out' : 'in');
    r = await post('/app/attendance/scan', { _csrf: csrf(r.text), expect });
    assert.equal(r.status, 302);
    const last = await knex('attendance_records').where({ business_id: A.businessId, user_id: nurse.userId }).orderBy('updated_at', 'desc').orderBy('id', 'desc').first();
    assert.equal(expect === 'in' ? last.in_method : last.out_method, 'qr');
    if (expect === 'in') assert.equal(Number((await knex('attendance_records').where({ business_id: A.businessId, user_id: nurse.userId }).count({ n: '*' }).first()).n), Number(before.n) + 1);
    // Staff without attendance.manage cannot open screens or working hours; with attendance.view missing, no board.
    assert.equal((await get('/app/attendance/screens')).status, 403);
    assert.equal((await get('/app/attendance/settings')).status, 403);
    assert.equal((await get(`/app/attendance/staff/${A.userId}`)).status, 403);
    assert.equal((await get(`/app/attendance/staff/${nurse.userId}`)).status, 200, 'own timesheet');
    r = await get('/app/attendance?view=today');
    assert.doesNotMatch(r.text, /att-board/);
  } finally {
    server.close();
  }
});
