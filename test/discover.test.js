// Discover: the shared clinic directory (only opted-in, active clinics that take bookings and have a doctor;
// filters; next-free-appointment caching), booking-channel inference (Referer and ?src whitelist), the booking
// widget's embed mode (frameable ONLY on embed routes; signed token instead of the session) and the no-show maths.
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
const channels = require('../src/modules/discover/channels');
const embed = require('../src/modules/discover/embed');
const dir = require('../src/modules/discover/directory.service');
const reports = require('../src/modules/discover/reports.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const C = {}; // clinics by role
let server; let base;

async function makeClinic(key, { listed = true, booking = true, doctor = true, city = 'Amman', specialty = 'dentistry', name } = {}) {
  const email = `disc-${key}-${tag}@t.test`;
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name: name || `Discover ${key} ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({
    onboarding_completed_at: new Date(), booking_enabled: booking, directory_listed: listed, city, specialty, slug: `disc-${key}-${tag}`.toLowerCase(),
  });
  businesses.forget(businessId);
  const ctx = { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'en' };
  const doctorId = doctor ? await doctors.saveDoctor(ctx, null, { full_name: `Dr. Zaid ${key} ${tag}`, slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' }) : null;
  return { ctx, businessId, doctorId, slug: `disc-${key}-${tag}`.toLowerCase() };
}
const mine = (rows) => rows.filter((r) => Object.values(C).some((c) => c.businessId === r.id));

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  C.a = await makeClinic('a', { city: '  AMMAN ' });
  C.b = await makeClinic('b', { listed: false });
  C.c = await makeClinic('c', { booking: false });
  C.d = await makeClinic('d', { doctor: false });
  C.e = await makeClinic('e', { city: 'irbid', specialty: 'طب الأسنان' }); // free-text specialty matching an Arabic label
  await knex('businesses').where({ id: C.a.businessId }).update({ name_en: `Shifa Center ${tag}` });
  await knex('doctors').where({ id: C.e.doctorId }).update({ full_name: `Dr. Hiba Nasser ${tag}` });
  await knex('insurance_providers').insert([
    { business_id: C.a.businessId, name: `MedNet ${tag}`, is_active: true },
    { business_id: C.e.businessId, name: `GlobeMed ${tag}`, is_active: true },
    { business_id: C.e.businessId, name: `Old Insurer ${tag}`, is_active: false },
  ]);
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await knex.destroy(); });

test('directory lists only opted-in active clinics with booking on and an active doctor', async () => {
  dir.forget();
  const { rows } = await dir.search(dir.filtersFrom({}), 'en');
  const ids = mine(rows).map((r) => r.id).sort();
  assert.deepEqual(ids, [C.a.businessId, C.e.businessId].sort());
  // Suspended clinics disappear too.
  await knex('businesses').where({ id: C.e.businessId }).update({ status: 'suspended' });
  dir.forget();
  assert.deepEqual(mine((await dir.search(dir.filtersFrom({}), 'en')).rows).map((r) => r.id), [C.a.businessId]);
  await knex('businesses').where({ id: C.e.businessId }).update({ status: 'active' });
  dir.forget();
});

test('directory filters: city (normalised), specialty (keys and labels), insurance, text', async () => {
  const f = (q) => dir.search(dir.filtersFrom(q), 'en').then((r) => mine(r.rows).map((x) => x.id));
  assert.deepEqual(await f({ city: 'amman' }), [C.a.businessId]);
  assert.deepEqual(await f({ city: 'Irbid  ' }), [C.e.businessId]);
  assert.equal(dir.specialtyKey('طب الأسنان'), 'dentistry');
  assert.equal(dir.specialtyKey('Dentistry'), 'dentistry');
  assert.equal((await f({ specialty: 'dentistry' })).length, 2);
  assert.deepEqual(await f({ specialty: 'cardiology' }), []);
  assert.deepEqual(await f({ insurance: `mednet ${tag}` }), [C.a.businessId]);
  assert.deepEqual(await f({ insurance: `Old Insurer ${tag}` }), []); // inactive providers are not offered
  assert.deepEqual(await f({ q: `hiba ${tag}` }), [C.e.businessId]); // doctor name
  assert.deepEqual(await f({ q: `SHIFA center ${tag}` }), [C.a.businessId]); // clinic name (either language)
  const { facets } = await dir.search(dir.filtersFrom({}), 'en');
  assert.ok(facets.cities.some((c) => c.key === 'amman'));
  assert.ok(facets.insurers.some((c) => c.label === `GlobeMed ${tag}`) && !facets.insurers.some((c) => c.label === `Old Insurer ${tag}`));
  assert.equal(dir.norm('  عمّان  '), dir.norm('عمان'));
});

test('earliest free slot: pure search across doctors and days', () => {
  const wh = { sun: { enabled: true, shifts: [{ start: '09:00', end: '10:00' }] }, mon: { enabled: true, shifts: [{ start: '08:00', end: '09:00' }] } };
  const docs = [{ id: 1, working_hours: wh, slot_duration_minutes: 30 }, { id: 2, working_hours: { mon: { enabled: true, shifts: [{ start: '07:30', end: '08:00' }] } }, slot_duration_minutes: 30 }];
  // 2026-10-04 is a Sunday.
  assert.deepEqual(dir.earliestSlot({ doctors: docs, today: '2026-10-04', nowMinutes: 0 }), { date: '2026-10-04', time: '09:00', doctorId: 1 });
  const booked = [{ doctor_id: 1, date: '2026-10-04', time: '09:00', duration: 60 }];
  assert.deepEqual(dir.earliestSlot({ doctors: docs, booked, today: '2026-10-04' }), { date: '2026-10-05', time: '07:30', doctorId: 2 });
  assert.deepEqual(dir.earliestSlot({ doctors: docs, daysOff: [{ doctor_id: 1, off_date: '2026-10-04' }], today: '2026-10-04', nowMinutes: 0 }).date, '2026-10-05');
  assert.equal(dir.earliestSlot({ doctors: docs, booked, today: '2026-10-04', days: 1 }), null);
});

test('next available is cached per clinic (5 min) and work per request is capped', async () => {
  dir.forget(C.a.businessId);
  const clinic = { id: C.a.businessId, timezone: 'Asia/Amman' };
  // Cap: with a budget of 0 nothing is computed.
  const [skipped] = await dir.withNext([{ ...clinic }], 0);
  assert.equal(skipped.next, undefined);
  assert.equal(skipped.nextKnown, false);
  const [first] = await dir.withNext([{ ...clinic }]);
  assert.ok(first.next && scheduling.isDate(first.next.date) && scheduling.isTime(first.next.time));
  // Book that exact slot: the cached answer stays until it expires or is forgotten.
  await appts.book(C.a.ctx, { doctor_id: C.a.doctorId, patient_name: 'Cache Test', patient_phone: '0791111111', appointment_date: first.next.date, appointment_time: first.next.time });
  const [cached] = await dir.withNext([{ ...clinic }]);
  assert.deepEqual(cached.next, first.next);
  dir.forget(C.a.businessId);
  const [fresh] = await dir.withNext([{ ...clinic }]);
  assert.notDeepEqual(fresh.next, first.next);
});

test('source inference: ?src whitelist and Referer', () => {
  assert.equal(channels.whitelist('Instagram'), 'instagram');
  assert.equal(channels.whitelist('evil'), null);
  assert.equal(channels.whitelist('staff'), null); // staff can't be claimed by a link
  const ref = (u) => channels.fromReferer(u, 'docbook.example');
  assert.equal(ref('https://l.instagram.com/?u=x'), 'instagram');
  assert.equal(ref('https://www.instagram.com/clinic'), 'instagram');
  assert.equal(ref('https://www.google.jo/'), 'google');
  assert.equal(ref('https://www.google.co.uk/search?q=x'), 'google');
  assert.equal(ref('https://maps.google.com/'), 'google');
  assert.equal(ref('https://m.facebook.com/'), 'facebook');
  assert.equal(ref('https://l.facebook.com/l.php'), 'facebook');
  assert.equal(ref('https://fb.me/x'), 'facebook');
  assert.equal(ref('https://t.co/abc'), 'x');
  assert.equal(ref('https://x.com/clinic'), 'x');
  assert.equal(ref('https://googleblog.example.com/'), 'website');
  assert.equal(ref('https://notinstagram.com/'), 'website');
  assert.equal(ref('https://docbook.example/clinics?city=amman'), 'directory');
  assert.equal(ref('https://docbook.example/alshifa'), null); // internal navigation keeps the earlier channel
  assert.equal(ref(''), null);
  assert.equal(ref('javascript:alert(1)'), null);
  assert.equal(channels.clinicPath('/alshifa/book'), 'alshifa');
  assert.equal(channels.clinicPath('/alshifa/book/online'), 'alshifa');
  assert.equal(channels.clinicPath('/clinics'), null);
  assert.equal(channels.clinicPath('/app'), null);
});

test('embed tokens are signed, clinic-bound and expire; allowed websites are validated', () => {
  const tok = embed.formToken(7, 'widget');
  assert.deepEqual(embed.readFormToken(tok), { clinicId: 7, src: 'widget' });
  assert.equal(embed.readFormToken(tok.replace('e1.7.', 'e1.8.')), null);
  assert.equal(embed.readFormToken(`${tok.slice(0, -1)}${tok.endsWith('A') ? 'B' : 'A'}`), null);
  assert.equal(embed.readFormToken(embed.formToken(7, 'widget', Date.now() - 7 * 3_600_000)), null);
  const done = embed.doneToken(7, 99);
  assert.deepEqual(embed.readDoneToken(done), { clinicId: 7, apptId: 99 });
  assert.equal(embed.readDoneToken(done.replace('.99.', '.98.')), null);
  const o = embed.parseOrigins('www.myclinic.com\nhttps://clinic.example.jo/ \nhttp://localhost:8080\nnot a site!');
  assert.deepEqual(o.origins, ['https://www.myclinic.com', 'https://clinic.example.jo', 'http://localhost:8080']);
  assert.ok(o.invalid.length > 0);
});

async function freeSlot(slug, doctorId) {
  for (let i = 2; i < 20; i += 1) {
    const d = new Date(`${scheduling.clinicNow('Asia/Amman').date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const r = await (await fetch(`${base}/${slug}/book/slots?doctor=${doctorId}&date=${date}`)).json(); // eslint-disable-line no-await-in-loop
    if (r.data && r.data.length) return { date, time: r.data[0] };
  }
  throw new Error('no free slot');
}
const cookieOf = (res) => res.headers.getSetCookie().map((h) => h.split(';')[0]).join('; ');
const tokenOf = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
const fa = (res) => ((res.headers.get('content-security-policy') || '').match(/frame-ancestors[^;]*/) || [''])[0];

test('public bookings store the channel: tracked link, referer; staff bookings are staff', async () => {
  const { slug, doctorId } = C.a;
  // Tracked link on the clinic page, then booking.
  let res = await fetch(`${base}/${slug}?src=instagram`);
  let cookie = cookieOf(res);
  res = await fetch(`${base}/${slug}/book`, { headers: { cookie } });
  let s = await freeSlot(slug, doctorId);
  res = await fetch(`${base}/${slug}/book`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: tokenOf(await res.text()), doctor_id: String(doctorId), appointment_date: s.date, appointment_time: s.time, patient_name: 'Insta Patient', patient_phone: '0792222001' }) });
  assert.equal(res.status, 302);
  assert.equal((await knex('appointments').where({ business_id: C.a.businessId, patient_name: 'Insta Patient' }).first('booking_channel')).booking_channel, 'instagram');
  // Referer from Google, no src.
  res = await fetch(`${base}/${slug}/book`, { headers: { referer: 'https://www.google.com/' } });
  cookie = cookieOf(res);
  s = await freeSlot(slug, doctorId);
  res = await fetch(`${base}/${slug}/book`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: tokenOf(await res.text()), doctor_id: String(doctorId), appointment_date: s.date, appointment_time: s.time, patient_name: 'Google Patient', patient_phone: '0792222002' }) });
  assert.equal(res.status, 302);
  assert.equal((await knex('appointments').where({ business_id: C.a.businessId, patient_name: 'Google Patient' }).first('booking_channel')).booking_channel, 'google');
  // Staff booking.
  const s2 = await freeSlot(slug, doctorId);
  const id = await appts.book(C.a.ctx, { doctor_id: doctorId, patient_name: 'Walk In', patient_phone: '0792222003', appointment_date: s2.date, appointment_time: s2.time });
  assert.equal((await knex('appointments').where({ id }).first('booking_channel')).booking_channel, 'staff');
});

test('embed CSP only on embed routes; embed booking works without cookies and is tagged "widget"', async () => {
  const { slug, doctorId } = C.a;
  let res = await fetch(`${base}/${slug}/book`);
  assert.equal(fa(res), "frame-ancestors 'none'");
  assert.ok(res.headers.get('x-frame-options'));
  res = await fetch(`${base}/${slug}`);
  assert.equal(fa(res), "frame-ancestors 'none'");
  res = await fetch(`${base}/clinics`);
  assert.equal(fa(res), "frame-ancestors 'none'");
  // Embed variant: frameable by any site, no X-Frame-Options, no site header.
  res = await fetch(`${base}/${slug}/book?embed=1`);
  assert.equal(fa(res), 'frame-ancestors *');
  assert.equal(res.headers.get('x-frame-options'), null);
  const html = await res.text();
  assert.ok(html.includes('embed-bar') && !html.includes('class="site-nav"'));
  const token = tokenOf(html);
  assert.ok(token.startsWith('e1.'));
  // POST with NO cookie at all (third-party frame): the signed token replaces the session CSRF token.
  const s = await freeSlot(slug, doctorId);
  res = await fetch(`${base}/${slug}/book?lang=en`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: token, doctor_id: String(doctorId), appointment_date: s.date, appointment_time: s.time, patient_name: 'Widget Patient', patient_phone: '0792222004' }) });
  assert.equal(res.status, 302);
  const loc = res.headers.get('location');
  assert.match(loc, new RegExp(`^/${slug}/book/done\\?e=d1\\.`));
  assert.equal((await knex('appointments').where({ business_id: C.a.businessId, patient_name: 'Widget Patient' }).first('booking_channel')).booking_channel, 'widget');
  res = await fetch(base + loc);
  assert.equal(res.status, 200);
  assert.equal(fa(res), 'frame-ancestors *');
  // A token of another clinic, or a tampered one, falls back to the normal CSRF check (refused).
  const other = embed.formToken(C.e.businessId, 'widget');
  res = await fetch(`${base}/${slug}/book`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ _csrf: other, doctor_id: String(doctorId) }) });
  assert.ok(res.status >= 400 || (res.status === 302 && !String(res.headers.get('location')).includes('/book/done')));
  assert.equal(await knex('appointments').where({ business_id: C.a.businessId, patient_phone: '0792222005' }).first('id'), undefined);
  // Allowed websites narrow frame-ancestors.
  await knex('businesses').where({ id: C.a.businessId }).update({ widget_origins: 'https://www.myclinic.com' });
  cache.forgetPrefix('discover:origins:');
  res = await fetch(`${base}/${slug}/book?embed=1`);
  assert.equal(fa(res), "frame-ancestors 'self' https://www.myclinic.com");
  // The widget script can be loaded by other sites.
  res = await fetch(`${base}/widget.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.ok(!(await res.text()).includes('__DB_PRIMARY__'));
});

test('no-show rate maths and the bookings report', async () => {
  assert.equal(reports.noShowRate({ completed: 8, noShow: 2 }), 20);
  assert.equal(reports.noShowRate({ completed: 0, noShow: 0 }), null);
  assert.equal(reports.noShowRate({ completed: 0, noShow: 3 }), 100);
  assert.equal(reports.weekStart('2026-10-07'), '2026-10-04'); // Wednesday → Sunday
  const ctx = C.e.ctx;
  const date = '2026-10-06';
  const rows = [
    ['completed', 'staff'], ['completed', 'staff'], ['completed', 'instagram'], ['no_show', 'instagram'], ['no_show', 'staff'], ['cancelled', 'instagram'], ['pending', null],
  ];
  for (const [i, [status, ch]] of rows.entries()) {
    await knex('appointments').insert({ // eslint-disable-line no-await-in-loop
      business_id: ctx.businessId, doctor_id: C.e.doctorId, patient_name: `R${i}`, patient_phone: `07933300${i}`, appointment_date: date, appointment_time: `1${i}:00`,
      status, appointment_type: 'in_person', source: ch === 'staff' ? 'staff' : 'website', booking_channel: ch,
    });
  }
  await knex('appointments').insert({ business_id: ctx.businessId, doctor_id: C.e.doctorId, patient_name: 'Block', appointment_date: date, appointment_time: '08:00', status: 'no_show', appointment_type: 'blocked', source: 'staff', booking_channel: 'staff' });
  const data = await reports.build(ctx, { from: '2026-10-01', to: '2026-10-31' }, { locale: 'en' });
  assert.equal(data.totals.n, 7); // the blocked time is not counted
  assert.equal(data.totals.completed, 3);
  assert.equal(data.totals.noShow, 2);
  assert.equal(data.totals.rate, 40); // 2 ÷ (3 + 2)
  const doc = data.doctors.find((d) => d.id === C.e.doctorId);
  assert.equal(doc.rate, 40);
  assert.equal(doc.cancelled, 1);
  const ig = data.channels.find((c) => c.key === 'instagram');
  assert.deepEqual([ig.n, ig.completed, ig.noShow, ig.cancelled, ig.rate], [3, 1, 1, 1, 50]);
  const web = data.channels.find((c) => c.key === 'website'); // no channel stored + source website → website
  assert.equal(web.n, 1);
  assert.equal(Math.round(data.channels.find((c) => c.key === 'staff').share * 10) / 10, 42.9);
  assert.equal(data.online, 4);
  assert.equal(data.staff, 3);
  const wk = data.weeks.find((w) => w.week === '2026-10-04');
  assert.deepEqual([wk.online, wk.staff], [4, 3]);
});
