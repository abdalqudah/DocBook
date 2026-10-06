const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent, agent, outbox } = require('./helpers');

const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];
let counsellor; let other; let admin; let marketing; let type;
test.before(async () => {
  await resetDb();
  counsellor = await makeStaff({ role: 'counsellor', name: 'Lina Mansour' });
  other = await makeStaff({ role: 'counsellor', name: 'Other Counsellor' });
  admin = await makeStaff({ role: 'admin' });
  marketing = await makeStaff({ role: 'marketing' });
  const [id] = await knex('appointment_types').insert({ slug: 'free-consultation', name_en: 'Free consultation', name_ar: 'استشارة مجانية', duration_min: 30, buffer_min: 10, location_mode: 'online', min_notice_hours: 2, max_days_ahead: 30 });
  type = await knex('appointment_types').where({ id }).first();
  await knex('appointment_type_staff').insert({ type_id: id, employee_id: counsellor.employee.id });
  const rows = [];
  for (let wd = 0; wd < 7; wd += 1) rows.push({ employee_id: counsellor.employee.id, weekday: wd, start_time: '00:00', end_time: '23:30' });
  await knex('availability').insert(rows);
});
test.after(() => knex.destroy());

const scheduling = () => require('../src/modules/booking/scheduling'); // eslint-disable-line global-require
const tomorrow = () => new Date(Date.now() + 86400_000).toISOString().slice(0, 10);

test('slot engine honours minimum notice, time off and existing bookings with buffer', async () => {
  const { slots } = await scheduling().slots(type.id, { fromDate: new Date().toISOString().slice(0, 10), days: 2 });
  assert.ok(slots.length > 10);
  assert.ok(slots.every((s) => s.start.getTime() >= Date.now() + 2 * 3600_000), 'minimum notice respected');
  const d = tomorrow();
  await knex('availability_exceptions').insert({ employee_id: counsellor.employee.id, date: d, is_off: true });
  const off = await scheduling().slots(type.id, { fromDate: d, days: 1 });
  assert.equal(off.slots.length, 0, 'day off has no slots');
  await knex('availability_exceptions').del();
  const free = await scheduling().slots(type.id, { fromDate: d, days: 1 });
  const s = free.slots[4];
  const appts = require('../src/modules/booking/appointments.service'); // eslint-disable-line global-require
  await appts.book({ userId: admin.user.id }, { typeId: type.id, employeeId: counsellor.employee.id, start: s.start, via: 'staff' });
  const after = await scheduling().slots(type.id, { fromDate: d, days: 1 });
  const blocked = after.slots.filter((x) => x.start < new Date(s.end.getTime() + 10 * 60000) && x.end > s.start);
  assert.equal(blocked.length, 0, 'booked time and its buffer are no longer offered');
  await assert.rejects(appts.book({ userId: admin.user.id }, { typeId: type.id, employeeId: counsellor.employee.id, start: s.start, via: 'staff' }), (e) => e.code === 'SLOT_TAKEN' || e.code === 'SLOT_BUSY', 'double booking refused');
  await knex('appointments').del();
});

test('two simultaneous bookings for the same time: exactly one wins', async () => {
  const appts = require('../src/modules/booking/appointments.service'); // eslint-disable-line global-require
  const { slots } = await scheduling().slots(type.id, { fromDate: tomorrow(), days: 1 });
  const start = slots[8].start;
  const results = await Promise.allSettled([1, 2, 3].map(() => appts.book({ userId: null }, { typeId: type.id, employeeId: counsellor.employee.id, start, via: 'website' })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(Number((await knex('appointments').count({ n: '*' }))[0].n), 1);
  await knex('appointments').del();
});

test('public booking creates a lead, the appointment, timeline entries, a confirmation e-mail and moves the lead stage', async () => {
  outbox.length = 0;
  const a = await agent();
  const page = await a.get('/book/schedule/free-consultation');
  assert.equal(page.status, 200);
  const href = /confirm\?start=([^&"]+)&(?:amp;)?with=(\d+)/.exec(page.text);
  assert.ok(href, `slots are offered: ${(page.text.match(/confirm[^"]{0,80}/) || ['none'])[0]}`);
  const confirm = await a.get(`/book/schedule/free-consultation/confirm?start=${href[1]}&with=${href[2]}`);
  assert.equal(confirm.status, 200);
  const body = { _csrf: csrfOf(confirm.text), start: decodeURIComponent(href[1]), with: href[2], first_name: 'Rami', last_name: 'Khaled', email: 'rami@example.com', consent_contact: '1' };
  const noConsent = await a.post('/book/schedule/free-consultation/confirm').type('form').send({ ...body, consent_contact: '' });
  assert.equal(noConsent.status, 422);
  const r = await a.post('/book/schedule/free-consultation/confirm').type('form').send(body);
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /^\/appointments\/[A-Za-z0-9_-]+\?booked=1$/);
  const lead = await knex('leads').where({ email: 'rami@example.com' }).first();
  const appt = await knex('appointments').where({ lead_id: lead.id }).first();
  assert.equal(appt.booked_via, 'website');
  assert.equal(appt.employee_id, counsellor.employee.id);
  const stage = await knex('lead_stages').where({ id: (await knex('leads').where({ id: lead.id }).first()).stage_id }).first();
  assert.equal(stage.key, 'counselling_booked');
  const acts = await knex('activities').where({ lead_id: lead.id }).pluck('title');
  assert.ok(acts.includes('appointment_booked'));
  assert.ok(outbox.some((m) => m.to === 'rami@example.com'), 'confirmation e-mail sent');
  // the same time again is refused without creating another lead
  const again = await a.post('/book/schedule/free-consultation/confirm').type('form').send({ ...body, email: 'someone@example.com' });
  assert.equal(again.status, 409);
  assert.equal(await knex('leads').where({ email: 'someone@example.com' }).first(), undefined);
  // manage link: calendar file, reschedule, cancel
  const manage = await a.get(r.headers.location);
  assert.equal(manage.status, 200);
  const token = r.headers.location.split('/')[2].split('?')[0];
  const ics = await a.get(`/appointments/${token}/calendar.ics`);
  assert.match(ics.text, /BEGIN:VEVENT/);
  const rs = await a.get(`/appointments/${token}?reschedule=1`);
  const newStart = /name="start" value="([^"]+)"/.exec(rs.text)[1];
  const moved = await a.post(`/appointments/${token}/reschedule`).type('form').send({ _csrf: csrfOf(rs.text), start: newStart });
  assert.equal(moved.status, 302);
  assert.equal((await knex('appointments').where({ id: appt.id }).first()).status, 'rescheduled');
  assert.equal((await a.get(`/appointments/${token}`)).status, 404, 'old link no longer works');
  const newToken = moved.headers.location.split('/')[2].split('?')[0];
  const c = await a.post(`/appointments/${newToken}/cancel`).type('form').send({ _csrf: csrfOf(rs.text), reason: 'Plans changed' });
  assert.equal(c.status, 302);
  assert.equal((await knex('appointments').where({ manage_token: newToken }).first()).status, 'cancelled');
});

test('staff: data scope on appointments and status changes', async () => {
  const appt = await knex('appointments').where({ status: 'cancelled' }).first();
  const o = await staffAgent(other);
  assert.equal((await o.get(`/staff/appointments/${appt.id}`)).status, 404, 'another counsellor cannot open it');
  const c = await staffAgent(counsellor);
  assert.equal((await c.get(`/staff/appointments/${appt.id}`)).status, 200);
  assert.equal((await c.get('/staff/appointments')).status, 200);
  assert.equal((await c.get('/staff/appointments/availability')).status, 200);
  const ad = await staffAgent(admin);
  const t = await ad.token();
  const page = await ad.get(`/staff/appointments/new?type=${type.id}&date=${tomorrow()}`);
  const slot = /name="slot" value="([^|]+)\|(\d+)"/.exec(page.text);
  assert.ok(slot, page.text.slice(page.text.indexOf('<main'), page.text.indexOf('<main') + 2500));
  const r = await ad.post('/staff/appointments').type('form').send({ _csrf: t, type_id: type.id, employee_id: slot[2], start: slot[1], mode: 'online' });
  assert.equal(r.status, 302);
  const id = Number(r.headers.location.split('/').pop());
  await ad.post(`/staff/appointments/${id}/status`).type('form').send({ _csrf: t, status: 'completed' });
  assert.equal((await knex('appointments').where({ id }).first()).status, 'completed');
});

test('courses: capacity, waiting list, promotion on cancel, attendance and a verifiable certificate', async () => {
  const [cid] = await knex('courses').insert({ slug: 'ielts', name_en: 'IELTS preparation', capacity: 1, price: 100, currency: 'USD' });
  const a = await agent();
  const reg = async (name, email) => {
    const p = await a.get('/courses/ielts');
    return a.post('/courses/ielts').type('form').send({ _csrf: csrfOf(p.text), name, email, consent_contact: '1' });
  };
  const r1 = await reg('Hala One', 'hala1@example.com');
  const r2 = await reg('Hala Two', 'hala2@example.com');
  assert.equal(r1.status, 302); assert.equal(r2.status, 302);
  const regs = await knex('course_registrations').where({ course_id: cid }).orderBy('id');
  assert.deepEqual(regs.map((x) => x.status), ['pending', 'waitlist']);
  assert.ok(regs.every((x) => x.lead_id), 'each registration is linked to a lead');
  const tok = r1.headers.location.split('/').pop().split('?')[0];
  const page = await a.get(`/courses/registration/${tok}`);
  await a.post(`/courses/registration/${tok}/cancel`).type('form').send({ _csrf: csrfOf(page.text) });
  assert.equal((await knex('course_registrations').where({ id: regs[1].id }).first()).status, 'pending', 'waiting list promoted');
  const ad = await staffAgent(admin);
  const t = await ad.token();
  await ad.post(`/staff/courses/registrations/${regs[1].id}`).type('form').send({ _csrf: t, status: 'confirmed' });
  const [sid] = await knex('course_sessions').insert({ course_id: cid, starts_at: new Date() });
  await ad.post(`/staff/courses/sessions/${sid}/attendance`).type('form').send({ _csrf: t, present: String(regs[1].id) });
  assert.equal((await knex('course_attendance').where({ session_id: sid })).length, 1);
  await ad.post(`/staff/courses/registrations/${regs[1].id}`).type('form').send({ _csrf: t, certificate: '1' });
  const done = await knex('course_registrations').where({ id: regs[1].id }).first();
  assert.match(done.certificate_no, /^GEC-\d{4}-[A-Z0-9]{6}$/);
  const cert = await a.get(`/certificates/${done.certificate_no}`);
  assert.equal(cert.status, 200); assert.match(cert.text, /Hala Two/);
  assert.equal((await a.get('/certificates/GEC-2026-NOPE00')).status, 404);
  const csv = await ad.get(`/staff/courses/${cid}/registrations?format=csv`);
  assert.match(csv.text, /Hala Two/);
});

test('events: registration gives a QR ticket; only permitted staff can check in, once', async () => {
  const [eid] = await knex('events').insert({ slug: 'uk-fair', title_en: 'UK fair', type: 'fair', starts_at: new Date(Date.now() + 5 * 86400_000), capacity: 50, meeting_url: 'https://meet.example.com/secret' });
  const a = await agent();
  const p = await a.get('/events/uk-fair');
  assert.equal(p.status, 200);
  assert.doesNotMatch(p.text, /meet\.example\.com\/secret/, 'meeting link is not public');
  assert.match(p.text, /application\/ld\+json/);
  const r = await a.post('/events/uk-fair').type('form').send({ _csrf: csrfOf(p.text), name: 'Yousef Ali', email: 'yousef@example.com', consent_contact: '1' });
  assert.equal(r.status, 302);
  const ticket = await a.get(r.headers.location);
  assert.match(ticket.text, /data:image\/svg\+xml;base64,/);
  const token = r.headers.location.split('/').pop().split('?')[0];
  const reg = await knex('event_registrations').where({ ticket_token: token }).first();
  assert.equal(reg.event_id, eid);
  const c = await staffAgent(counsellor);
  assert.equal((await c.get(`/staff/events/checkin/${token}`)).status, 403, 'counsellors cannot check in');
  const m = await staffAgent(marketing);
  const t = await m.token();
  const ok = await m.post(`/staff/events/checkin/${token}`).type('form').send({ _csrf: t });
  assert.match(ok.text, /Checked in/);
  const again = await m.post(`/staff/events/checkin/${token}`).type('form').send({ _csrf: t });
  assert.match(again.text, /Already checked in/);
  assert.equal((await knex('event_registrations').where({ id: reg.id }).first()).status, 'attended');
  assert.ok((await knex('activities').where({ lead_id: reg.lead_id }).pluck('title')).includes('event_attended'));
});
