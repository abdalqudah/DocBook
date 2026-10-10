// The reception's call outcome on an appointment (no answer / call back, beside the status — the booking keeps its
// time) and its note, editable from the appointment page and the calendar drawer; audited; Clinica's calendar
// brings them over.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const scheduling = require('../src/modules/clinic/scheduling');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = `ac-${tag}@t.test`;
let app; let b; let apptId;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const u = await knex.transaction(async (trx) => { const id = await auth.createUser(trx, { name: 'Owner', email: mail, password: 'Passw0rd!x' }); await businesses.create(id, { name: `Call ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx); return id; });
  await knex('users').where({ id: u }).update({ email_verified_at: new Date() });
  b = (await knex('users').where({ id: u }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
  const [doc] = await knex('doctors').insert({ business_id: b, full_name: 'Dr C', is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()), slot_duration_minutes: 30 });
  [apptId] = await knex('appointments').insert({ business_id: b, doctor_id: doc, patient_name: 'Call Patient', patient_phone: '0790002222', appointment_date: scheduling.clinicNow('Asia/Amman').date, appointment_time: '11:00', status: 'confirmed', appointment_type: 'in_person', source: 'staff' });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('no answer / call back and the note, from the appointment page; the status stays', async () => {
  const o = app.agent(); await o.login(mail);
  let r = await o.get(`/app/appointments/${apptId}?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /No answer/); assert.match(r.text, /Call back/);
  r = await o.submit(`/app/appointments/${apptId}`, `/app/appointments/${apptId}/call`, { call_status: 'no_answer' });
  assert.equal(r.status, 302);
  let a = await knex('appointments').where({ id: apptId }).first();
  assert.equal(a.call_status, 'no_answer'); assert.equal(a.status, 'confirmed'); assert.ok(a.call_status_at);
  r = await o.submit(`/app/appointments/${apptId}`, `/app/appointments/${apptId}/note`, { notes: 'اطمني إنو أمورها تمام' });
  a = await knex('appointments').where({ id: apptId }).first();
  assert.equal(a.notes, 'اطمني إنو أمورها تمام');
  r = await o.get(`/app/appointments/${apptId}/peek?lang=en`);
  assert.equal(r.status, 200); assert.match(r.text, /No answer/); assert.match(r.text, /اطمني/);
  r = await o.submit(`/app/appointments/${apptId}`, `/app/appointments/${apptId}/call`, { call_status: 'bogus' });
  assert.equal((await knex('appointments').where({ id: apptId }).first()).call_status, 'no_answer', 'an unknown value changes nothing');
  r = await o.submit(`/app/appointments/${apptId}`, `/app/appointments/${apptId}/call`, { call_status: '' });
  assert.equal((await knex('appointments').where({ id: apptId }).first()).call_status, null);
  assert.ok(await knex('audit_logs').where({ business_id: b, action: 'appointment.call_status' }).first('id'));
});

test('Clinica: no-answer / recall and the note of a calendar row', () => {
  const cw = require('../src/modules/legacy/clinica-web'); // eslint-disable-line global-require
  const rows = cw.calendarDay('<table><tr><th>Time</th><th>Patient Name</th><th>Calendar</th><th>Status</th><th>Note</th></tr>'
    + '<tr><td>10:00</td><td><a href="/dental/5">A</a></td><td>Mansour</td><td>no-answer</td><td>اطمني إنو أمورها تمام</td></tr>'
    + '<tr><td>10:30</td><td><a href="/dental/6">B</a></td><td>Mansour</td><td>Recall</td><td></td></tr></table>');
  assert.deepEqual(rows.map((x) => [x.callStatus, x.note, x.status]), [['no_answer', 'اطمني إنو أمورها تمام', null], ['recall', null, null]]);
});

test('move to another doctor from the appointment page: same day, a free time; a taken time is refused', async () => {
  const o = app.agent(); await o.login(mail);
  const wh = JSON.stringify(scheduling.defaultWorkingHours());
  const [d1] = await knex('doctors').insert({ business_id: b, full_name: 'Dr One', is_active: true, working_hours: wh, slot_duration_minutes: 30 });
  const [d2] = await knex('doctors').insert({ business_id: b, full_name: 'Dr Two', is_active: true, working_hours: wh, slot_duration_minutes: 30 });
  const d = new Date(`${scheduling.clinicNow('Asia/Amman').date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 2); while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  const day = d.toISOString().slice(0, 10);
  const base = { business_id: b, appointment_date: day, status: 'confirmed', appointment_type: 'in_person', source: 'staff' };
  const [id] = await knex('appointments').insert({ ...base, doctor_id: d1, patient_name: 'Move Me', appointment_time: '10:00' });
  await knex('appointments').insert({ ...base, doctor_id: d2, patient_name: 'Busy', appointment_time: '12:00' });
  let r = await o.get(`/app/appointments/${id}?lang=en`);
  assert.match(r.text, /Move to another doctor/); assert.match(r.text, /data-transfer/);
  r = await o.submit(`/app/appointments/${id}`, `/app/appointments/${id}/transfer`, { doctor_id: String(d2), appointment_time: '10:00' });
  assert.equal(r.status, 302);
  let a = await knex('appointments').where({ id }).first();
  assert.equal(a.doctor_id, d2); assert.equal(String(a.appointment_time).slice(0, 5), '10:00');
  r = await o.submit(`/app/appointments/${id}`, `/app/appointments/${id}/transfer`, { doctor_id: String(d1), appointment_time: '12:00' });
  await o.submit(`/app/appointments/${id}`, `/app/appointments/${id}/transfer`, { doctor_id: String(d2), appointment_time: '12:00' });
  a = await knex('appointments').where({ id }).first();
  assert.equal(String(a.appointment_time).slice(0, 5), '12:00', 'moved back to Dr One at 12:00 (free there)');
  assert.equal(a.doctor_id, d1, 'Dr Two is taken at 12:00: refused, nothing changed');
  assert.ok(await knex('audit_logs').where({ business_id: b, action: 'appointment.moved', entity_id: id }).first('id'));
});

test('the clinic (room) number of each doctor today: set on the calendar or the front desk, shown on the waiting-room screen', async () => {
  const o = app.agent(); await o.login(mail);
  const today = scheduling.clinicNow('Asia/Amman').date;
  const docId = (await knex('appointments').where({ id: apptId }).first('doctor_id')).doctor_id;
  await knex('doctors').where({ id: docId }).update({ room: '1' });
  let r = await o.get(`/app/appointments?date=${today}&lang=en`);
  assert.match(r.text, /data-cal-room/);
  r = await o.submit(`/app/appointments?date=${today}`, '/app/appointments/room', { doctor_id: String(docId), day: today, room: '3' });
  assert.equal(r.status, 302);
  assert.equal((await knex('doctor_day_rooms').where({ doctor_id: docId, day: today }).first('room')).room, '3');
  assert.equal((await knex('doctors').where({ id: docId }).first('room')).room, '1', 'the usual room stays');
  // the waiting-room screen: today's room
  await knex('appointments').where({ id: apptId }).update({ checked_in: true, status: 'confirmed', arrived_at: new Date() });
  const queue = require('../src/modules/queue/queue.service'); // eslint-disable-line global-require
  const board = await queue.board({ name_style: 'full', show_name: true, branch_id: null, scope: 'clinic' }, { id: b });
  assert.equal(board.next.room, '3');
  // the front desk shows it
  r = await o.get('/app/front-desk?lang=en');
  assert.match(r.text, /Clinic 3/);
  assert.match(r.text, /data-fx-rooms/);
});

test('the cash desk shows each doctor\'s clinic number; an assistant belongs to a clinic number and opens on its doctor', async () => {
  const o = app.agent(); await o.login(mail);
  const today = scheduling.clinicNow('Asia/Amman').date;
  // the cashier queue (the visit above is checked in, in clinic 3)
  let r = await o.get('/app/cashier?lang=en');
  assert.equal(r.status, 200); assert.match(r.text, /Clinic 3/);
  r = await o.get('/app/cashier/screen/data');
  assert.ok(JSON.parse(r.text).visits.some((v) => v.room === 'Clinic 3'));
  // a nurse of clinic 3
  const role = await knex('roles').where({ business_id: b, key: 'nurse' }).first('id') || await knex('roles').where({ business_id: b }).whereNotIn('key', ['owner', 'doctor']).first('id');
  r = await o.submit('/app/clinic/team', '/app/clinic/team', { name: 'Nurse Room Three', email: `nr-${tag}@t.test`, role_id: String(role.id), mode: 'password', locale: 'en', room: '3' });
  assert.equal(r.status, 302);
  const m = await knex('memberships').where({ business_id: b }).whereIn('user_id', knex('users').where({ email: `nr-${tag}@t.test` }).select('id')).first('room');
  assert.equal(m.room, '3');
  r = await o.get(`/app/appointments?date=${today}&lang=en`);
  assert.match(r.text, /Assistant: Nurse Room Three/);
  r = await o.get('/app/clinic/team?lang=en');
  assert.match(r.text, /data-member-room/);
});
