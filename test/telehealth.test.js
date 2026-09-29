// Online consultations (telehealth) against the test database (docbook_test): online slots never collide with
// in-clinic bookings, time-zone conversion for display, consultation-link access rules (no access to other
// patients or their files), file sniffing and limits, the join window, and signaling authentication.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const appts = require('../src/modules/clinic/appointments.service');
const scheduling = require('../src/modules/clinic/scheduling');
const tele = require('../src/modules/telehealth/telehealth.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let other; let clinic; let doctorId; let sunday; let server; let base;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, 1)]);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const file = (buffer, originalname) => ({ buffer, originalname, size: buffer.length });

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), booking_enabled: true, online_enabled: true });
  businesses.forget(businessId);
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'en' };
}

function nextSunday() {
  const d = new Date(`${scheduling.clinicNow('Asia/Amman').date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const patient = (time, extra = {}) => ({
  doctor_id: doctorId, appointment_date: sunday, appointment_time: time, patient_name: 'Lena Schmidt', patient_phone: `+49151${tag.slice(-7)}`,
  patient_email: 'lena@example.com', patient_country: 'DE', patient_timezone: 'Europe/Berlin', reason: 'Knee pain', ...extra,
});
const publicCtx = () => ({ businessId: ctx.businessId, timezone: 'Asia/Amman', permissions: new Set(), locale: 'en' });

/** Cookie + CSRF aware client. */
function client() {
  const jar = {};
  let csrf = '';
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => { for (const h of res.headers.getSetCookie()) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } };
  const read = async (res) => {
    store(res);
    const text = await res.text();
    const m = text.match(/name="csrf-token" content="([^"]+)"/); if (m) csrf = m[1];
    let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text, json };
  };
  return {
    get: async (path) => read(await fetch(base + path, { headers: { cookie: cookie(), accept: path.includes('/signal') ? 'application/json' : 'text/html' }, redirect: 'manual' })),
    post: async (path, data = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...data })) body.append(k, v);
      return read(await fetch(base + path, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' }));
    },
    json: async (path, data, { noCsrf } = {}) => read(await fetch(base + path, {
      method: 'POST', redirect: 'manual', body: JSON.stringify(data),
      headers: { cookie: cookie(), 'content-type': 'application/json', accept: 'application/json', ...(noCsrf ? {} : { 'x-csrf-token': csrf }) },
    })),
    multipart: async (path, fields, files) => {
      const fd = new FormData();
      fd.append('_csrf', csrf);
      Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
      files.forEach((f) => fd.append('files', new Blob([f.buffer]), f.name));
      return read(await fetch(base + path, { method: 'POST', headers: { cookie: cookie() }, body: fd, redirect: 'manual' }));
    },
  };
}
async function signIn(email) {
  const c = client();
  await c.get('/login');
  const r = await c.post('/login', { email, password: 'Passw0rd!x' });
  assert.equal(r.status, 302);
  return c;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ctx = await makeClinic(`tele${tag}@t.test`, 'Tele clinic');
  other = await makeClinic(`tele-other${tag}@t.test`, 'Other clinic');
  await knex('businesses').where({ id: ctx.businessId }).update({ slug: `tele-${tag}` });
  businesses.forget(ctx.businessId);
  clinic = await businesses.get(ctx.businessId);
  // Default hours Sat–Thu 09–17 (break 13–14); online window Sunday 09:00–11:00, 20-minute consultations, 35 JOD.
  doctorId = await doctors.saveDoctor(ctx, null, {
    full_name: 'Dr. Online', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1',
    online_form: '1', online_enabled: '1', online_fee: '35', online_duration_minutes: '20', online_method: 'builtin',
    ow: { sun: { enabled: '1', s1: '09:00', e1: '11:00' } },
  });
  sunday = nextSunday();
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await knex.destroy(); });

test('time zones: clinic times shown in the patient zone, across DST and date lines', () => {
  assert.equal(tele.isZone('Europe/Berlin'), true);
  assert.equal(tele.isZone('Mars/Olympus'), false);
  assert.equal(tele.isZone('../../etc/passwd'), false);
  assert.equal(tele.isZone(''), false);
  // Amman is UTC+3 all year; Berlin is UTC+2 in summer time and UTC+1 after 25 Oct 2026.
  assert.deepEqual(tele.toZone('2026-10-04', '10:00', 'Asia/Amman', 'Europe/Berlin'), { date: '2026-10-04', time: '09:00', utc: Date.UTC(2026, 9, 4, 7, 0), shift: 0 });
  assert.equal(tele.toZone('2026-10-26', '10:00', 'Asia/Amman', 'Europe/Berlin').time, '08:00');
  assert.equal(tele.toZone('2026-10-04', '10:00', 'Asia/Amman', 'America/New_York').time, '03:00');
  const la = tele.toZone('2026-10-04', '09:00', 'Asia/Amman', 'America/Los_Angeles');
  assert.deepEqual([la.date, la.time, la.shift], ['2026-10-03', '23:00', -1]);
  const tokyo = tele.toZone('2026-10-04', '20:00', 'Asia/Amman', 'Asia/Tokyo');
  assert.deepEqual([tokyo.date, tokyo.time, tokyo.shift], ['2026-10-05', '02:00', 1]);
  const rows = tele.slotsInZone(['10:00'], '2026-10-04', 'Asia/Amman', 'Europe/Berlin');
  assert.equal(rows[0].local, '09:00');
});

test('online slots use the online windows and never collide with in-clinic appointments', async () => {
  const clinicAppt = await appts.book(ctx, { doctor_id: doctorId, patient_name: 'Walk-in', patient_phone: '0790000001', appointment_date: sunday, appointment_time: '09:30' });
  assert.ok(clinicAppt);
  // 20-minute steps from 09:00; 09:20 and 09:40 overlap the 09:30–10:00 visit; the window ends at 11:00.
  assert.deepEqual(await tele.onlineSlots(clinic, doctorId, sunday), ['09:00', '10:00', '10:20', '10:40']);
  const booked = await tele.bookOnline(publicCtx(), clinic, patient('10:00'), []);
  const a = await knex('appointments').where({ id: booked.appointmentId }).first();
  assert.equal(a.appointment_type, 'online');
  assert.equal(a.duration_minutes, 20);
  assert.equal(Number(a.amount_due), 35);
  assert.equal(a.status, 'pending');
  // The in-clinic calendar now skips 10:00 (10:00–10:30 would overlap 10:00–10:20)…
  const inClinic = await scheduling.availableSlots({ businessId: ctx.businessId, timezone: 'Asia/Amman', doctorId, date: sunday });
  assert.ok(!inClinic.includes('10:00') && !inClinic.includes('09:30') && inClinic.includes('10:30'));
  await assert.rejects(() => appts.book(ctx, { doctor_id: doctorId, patient_name: 'X', patient_phone: '0790000002', appointment_date: sunday, appointment_time: '10:00' }), (e) => e.code === 'SLOT_TAKEN');
  // …and online booking refuses the in-clinic time and anything outside the online window.
  await assert.rejects(() => tele.bookOnline(publicCtx(), clinic, patient('09:20'), []), (e) => e.code === 'SLOT_TAKEN');
  await assert.rejects(() => tele.bookOnline(publicCtx(), clinic, patient('14:00'), []), (e) => e.code === 'SLOT_TAKEN');
  assert.deepEqual(await tele.onlineSlots(clinic, doctorId, sunday), ['09:00', '10:20', '10:40']);
  // A doctor that doesn't offer online consultations can't be booked online.
  const offline = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. Offline', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  await assert.rejects(() => tele.onlineSlots(clinic, offline, sunday), (e) => e.code === 'VALIDATION_FAILED');
});

test('files: bytes are sniffed, count and size are limited', () => {
  assert.equal(tele.sniff(pdf), 'pdf');
  assert.equal(tele.sniff(png), 'png');
  assert.equal(tele.sniff(jpg), 'jpg');
  assert.equal(tele.sniff(Buffer.from('<html><script>alert(1)</script></html>')), null);
  const ok = tele.checkFiles([file(pdf, 'lab results.PDF'), file(png, '../../x-ray.png'), file(jpg, 'photo.jpeg')]);
  assert.deepEqual(ok.map((f) => [f.name, f.mime]), [['lab results.pdf', 'application/pdf'], ['x-ray.png', 'image/png'], ['photo.jpg', 'image/jpeg']]);
  assert.throws(() => tele.checkFiles([file(Buffer.from('<svg onload=alert(1)>......'), 'scan.pdf')]), (e) => e.code === 'TELE_FILE_TYPE');
  assert.throws(() => tele.checkFiles(Array.from({ length: 6 }, (_, i) => file(pdf, `f${i}.pdf`))), (e) => e.code === 'TELE_TOO_MANY_FILES');
  const big = Buffer.concat([pdf, Buffer.alloc(tele.MAX_FILE_BYTES)]);
  assert.throws(() => tele.checkFiles([file(big, 'big.pdf')]), (e) => e.code === 'TELE_FILE_TOO_BIG');
  assert.equal(tele.normalizePhone('49', '0151 2345 6789'), '+4915123456789');
  assert.equal(tele.normalizePhone('962', '+962 79 000 0000'), '+962790000000');
  assert.equal(tele.normalizePhone('999', '123'), null);
});

test('join window: the patient joins 10 min early until the end + grace, only once confirmed', () => {
  const row = { appointment_date: '2026-10-04', appointment_time: '10:00', duration_minutes: 20, status: 'confirmed', payment_status: 'unpaid', payment_required: false };
  const start = tele.zonedToUtc('2026-10-04', '10:00', 'Asia/Amman');
  const min = 60_000;
  assert.equal(tele.canJoin(row, 'Asia/Amman', 'patient', start - 11 * min), false);
  assert.equal(tele.canJoin(row, 'Asia/Amman', 'patient', start - 9 * min), true);
  assert.equal(tele.canJoin(row, 'Asia/Amman', 'patient', start + (20 + 14) * min), true);
  assert.equal(tele.canJoin(row, 'Asia/Amman', 'patient', start + (20 + 16) * min), false);
  assert.equal(tele.canJoin(row, 'Asia/Amman', 'doctor', start - 25 * min), true);
  assert.equal(tele.canJoin({ ...row, status: 'pending' }, 'Asia/Amman', 'patient', start), false);
  assert.equal(tele.canJoin({ ...row, status: 'cancelled' }, 'Asia/Amman', 'doctor', start), false);
  assert.equal(tele.stateOf({ ...row, status: 'pending', payment_required: true }), 'awaiting_payment');
  assert.equal(tele.stateOf({ ...row, status: 'pending', payment_required: true, payment_status: 'paid' }), 'pending');
});

test('booking page, consultation link access and staff-only files', async () => {
  const slug = `tele-${tag}`;
  const p = client();
  const page = await p.get(`/${slug}/book/online`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Dr\. Online/);
  // A file that isn't really a PDF is refused; nothing is booked.
  const fields = { doctor_id: String(doctorId), appointment_date: sunday, appointment_time: '10:40', patient_timezone: 'Europe/Berlin', patient_name: 'Omar Haddad',
    patient_country: 'SE', phone_code: '46', phone_number: '070 123 45 67', patient_email: 'omar@example.com', reason: 'Second opinion before travelling' };
  const bad = await p.multipart(`/${slug}/book/online`, fields, [{ buffer: Buffer.from('MZ fake executable......'), name: 'report.pdf' }]);
  assert.equal(bad.status, 422);
  assert.equal((await knex('appointments').where({ business_id: ctx.businessId, patient_name: 'Omar Haddad' }).count({ n: '*' }))[0].n, 0);
  // Without the CSRF token: refused.
  const noCsrf = await fetch(`${base}/${slug}/book/online`, { method: 'POST', body: new FormData(), redirect: 'manual' });
  assert.notEqual(noCsrf.status, 303);
  const ok = await p.multipart(`/${slug}/book/online`, fields, [{ buffer: pdf, name: 'report.pdf' }, { buffer: png, name: 'scan.png' }]);
  assert.equal(ok.status, 303);
  const link = ok.location;
  assert.match(link, /^\/c\/[A-Za-z0-9_-]{43}\?new=1$/);
  const token = link.slice(3, 46);

  const mine = await p.get(`/c/${token}`);
  assert.equal(mine.status, 200);
  assert.match(mine.text, /noindex/);
  assert.match(mine.headers.get('content-security-policy'), /media-src 'self' blob:/);
  assert.match(mine.text, /Omar Haddad|Dr\. Online/);
  assert.doesNotMatch(mine.text, /Lena Schmidt/); // nobody else's booking
  assert.equal((await p.get(`/c/${token.slice(0, -2)}xx`)).status, 404);
  assert.equal((await p.get('/c/not-a-token')).status, 404);

  const row = await tele.byToken(token);
  assert.equal(row.patient_timezone, 'Europe/Berlin');
  assert.equal(row.patient_phone, '+46701234567');
  const files = await tele.filesOf(ctx.businessId, row.id);
  assert.equal(files.length, 2);
  // Files: never through the patient link; not for anonymous visitors or another clinic; yes for the clinic.
  assert.equal((await p.get(`/c/${token}/files/${files[0].id}`)).status, 404);
  const anon = await p.get(`/app/telehealth/${row.appointment_id}/files/${files[0].id}`);
  assert.equal(anon.status, 302);
  const stranger = await signIn(`tele-other${tag}@t.test`);
  assert.equal((await stranger.get(`/app/telehealth/${row.appointment_id}/files/${files[0].id}`)).status, 404);
  const owner = await signIn(`tele${tag}@t.test`);
  const f = await owner.get(`/app/telehealth/${row.appointment_id}/files/${files[1].id}`);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'image/png');
  assert.match(f.headers.get('content-security-policy'), /sandbox/);
  // Staff see the link (encrypted at rest — the database holds only a hash and ciphertext).
  const apptPage = await owner.get(`/app/appointments/${row.appointment_id}`);
  assert.ok(apptPage.text.includes(`/c/${token}`));
  const stored = await knex('online_consultations').where({ id: row.id }).first('token_hash', 'token_enc');
  assert.ok(!stored.token_enc.includes(token) && stored.token_hash !== token);
});

test('signaling: patient by token inside the window, doctor by session and clinic scope', async () => {
  const booked = await tele.bookOnline(publicCtx(), clinic, patient('09:00', { patient_phone: '+4917000000001', patient_name: 'Signal Patient' }), []);
  const token = booked.token;
  const p = client();
  await p.get(`/c/${token}`);
  // Pending: the patient can't signal yet.
  assert.equal((await p.json(`/c/${token}/signal`, { kind: 'hello' })).status, 403);
  // Confirm and move the test appointment to "now" in the clinic, so the join window is open.
  const now = scheduling.clinicNow('Asia/Amman');
  await knex('appointments').where({ id: booked.appointmentId }).update({ status: 'confirmed', appointment_date: now.date, appointment_time: scheduling.minutesToTime(Math.max(0, now.minutes - 1)) });
  assert.notEqual((await p.json(`/c/${token}/signal`, { kind: 'hello' }, { noCsrf: true })).status, 200); // CSRF required
  const cursor = (await p.get(`/c/${token}/signal`)).json;
  assert.equal(cursor.ok, true);
  const hello = await p.json(`/c/${token}/signal`, { kind: 'hello' });
  assert.equal(hello.json.ok, true);
  assert.equal((await p.json(`/c/${token}/signal`, { kind: 'shell', payload: {} })).status, 422);
  // Joining marks the patient as arrived (no front-desk check-in).
  assert.equal((await knex('appointments').where({ id: booked.appointmentId }).first('checked_in')).checked_in, 1);

  const owner = await signIn(`tele${tag}@t.test`);
  const stranger = await signIn(`tele-other${tag}@t.test`);
  await owner.get(`/app/visits/${booked.appointmentId}`);
  await stranger.get('/app');
  // Another clinic can't read or write this consultation's signaling; a visitor without a session neither.
  assert.equal((await stranger.get(`/app/telehealth/${booked.appointmentId}/signal`)).status, 404);
  assert.equal((await stranger.json(`/app/telehealth/${booked.appointmentId}/signal`, { kind: 'hello' })).status, 404);
  assert.notEqual((await client().get(`/app/telehealth/${booked.appointmentId}/signal`)).status, 200);
  // The doctor sees the patient's messages (not their own), and vice versa.
  const d = (await owner.get(`/app/telehealth/${booked.appointmentId}/signal?after=${cursor.last}`)).json;
  assert.deepEqual(d.messages.map((m) => m.kind), ['hello']);
  assert.equal(d.peer, true);
  const offer = await owner.json(`/app/telehealth/${booked.appointmentId}/signal`, { kind: 'offer', payload: { sid: 'abc', sdp: { type: 'offer', sdp: 'v=0' } } });
  assert.equal(offer.json.ok, true);
  const pm = (await p.get(`/c/${token}/signal?after=${cursor.last}`)).json;
  assert.deepEqual(pm.messages.map((m) => [m.kind, m.payload.sid]), [['offer', 'abc']]);
  // Another patient's token never sees these messages.
  const otherBooking = await tele.bookOnline(publicCtx(), clinic, patient('10:20', { patient_phone: '+4917000000002', patient_name: 'Other Patient' }), []);
  await knex('appointments').where({ id: otherBooking.appointmentId }).update({ status: 'confirmed', appointment_date: now.date, appointment_time: scheduling.minutesToTime(Math.max(0, now.minutes - 1)) });
  const q = client();
  await q.get(`/c/${otherBooking.token}`);
  const theirs = (await q.get(`/c/${otherBooking.token}/signal?after=0`)).json;
  assert.deepEqual(theirs.messages, []);
  // Cancelled: nobody can join any more.
  await appts.setStatus(ctx, booked.appointmentId, 'cancelled');
  assert.equal((await p.json(`/c/${token}/signal`, { kind: 'hello' })).status, 403);
  assert.equal((await owner.json(`/app/telehealth/${booked.appointmentId}/signal`, { kind: 'hello' })).status, 403);
});
