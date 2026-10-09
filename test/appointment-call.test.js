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
