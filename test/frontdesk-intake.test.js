// Reception board: while the patient waits, vital signs and the chief complaint are written from the board (vitals.edit,
// clinic scope); the doctor sees the complaint on the visit; payment never shows on the board; a patient with the
// doctor has the prescription / print / payment icons.
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
const mail = (k) => `fd-${k}-${tag}@t.test`;
let app; let businessId; let waiting; let inRoom; let other;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const mk = async (k) => {
    const userId = await knex.transaction(async (trx) => {
      const id = await auth.createUser(trx, { name: 'Owner', email: mail(k), password: 'Passw0rd!x' });
      await businesses.create(id, { name: `Board ${k}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
      return id;
    });
    await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
    const { last_business_id: b } = await knex('users').where({ id: userId }).first('last_business_id');
    await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
    return b;
  };
  businessId = await mk('a');
  const otherBiz = await mk('b');
  const today = scheduling.clinicNow('Asia/Amman').date;
  const [doc] = await knex('doctors').insert({ business_id: businessId, full_name: 'Dr Board', is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()), slot_duration_minutes: 30 });
  const add = async (b, name, extra) => (await knex('appointments').insert({ business_id: b, doctor_id: b === businessId ? doc : null, patient_name: name, patient_phone: '0790000000', appointment_date: today, appointment_time: '09:00', status: 'confirmed', appointment_type: 'in_person', source: 'staff', ...extra }))[0];
  waiting = await add(businessId, 'Waiting Patient', { checked_in: true, arrived_at: new Date() });
  inRoom = await add(businessId, 'Room Patient', { checked_in: true, with_doctor: true, arrived_at: new Date(), called_at: new Date() });
  other = await add(otherBiz, 'Other Clinic', { checked_in: true, arrived_at: new Date() });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('reception board: vitals and complaint while waiting; icons only with the doctor; no payment columns', async () => {
  const o = app.agent(); await o.login(mail('a'));
  let r = await o.get('/app/front-desk?lang=en');
  assert.equal(r.status, 200);
  assert.ok(!/id="fx-ready"|id="fx-paid"/.test(r.text), 'no "to pay" / "paid" columns');
  assert.match(r.text, new RegExp(`data-action="/app/front-desk/${waiting}/intake"`));
  assert.match(r.text, new RegExp(`/app/front-desk/${inRoom}/intake`), 'vitals can still be corrected while the patient is with the doctor');
  assert.match(r.text, new RegExp(`href="/app/cashier/screen\\?add=${inRoom}"`), 'payment icon for the patient with the doctor');
  assert.ok(!new RegExp(`/app/cashier/screen\\?add=${waiting}`).test(r.text), 'no payment icon while waiting');
  r = await o.submit('/app/front-desk', `/app/front-desk/${waiting}/intake`, { chief_complaint: 'Tooth pain for two days', bloodPressure: '130/85', temperatureC: '37.8' });
  assert.equal(r.status, 302);
  const c = await knex('consultations').where({ appointment_id: waiting }).first('chief_complaint', 'vital_signs');
  assert.equal(c.chief_complaint, 'Tooth pain for two days');
  assert.match(String(typeof c.vital_signs === 'string' ? c.vital_signs : JSON.stringify(c.vital_signs)), /130\/85/);
  r = await o.get('/app/front-desk?lang=en');
  assert.match(r.text, /Tooth pain for two days/);
  r = await o.get(`/app/visits/${waiting}?lang=en`);
  assert.match(r.text, /Tooth pain for two days/, 'the doctor sees the complaint');
  // a bad value is refused with its reason; another clinic's visit cannot be written
  // a wrong value reopens the form with everything typed kept and the reason under that field; nothing is saved
  r = await o.submit('/app/front-desk?lang=en', `/app/front-desk/${waiting}/intake`, { chief_complaint: 'Fever since morning', bloodPressure: '120/80', pulseBpm: '900' });
  assert.equal(r.status, 422);
  assert.match(r.text, /id="fx-intake"[^>]*data-open-on-load/);
  assert.match(r.text, /Fever since morning<\/textarea>/);
  assert.match(r.text, /name="bloodPressure" value="120\/80"/);
  assert.match(r.text, /between 20 and 250/);
  assert.match((await knex('consultations').where({ appointment_id: waiting }).first('chief_complaint')).chief_complaint, /Tooth pain/);
  r = await o.submit('/app/front-desk', `/app/front-desk/${other}/intake`, { chief_complaint: 'x' });
  assert.ok(!(await knex('consultations').where({ appointment_id: other }).first()), 'other clinic untouched');
});

test('an online booking notification reads as a sentence, not the word "online"', async () => {
  await require('../src/modules/notifications/notification.service').notify(businessId, { permission: 'appointments.manage', type: 'appointment.booked_online', title: 'Web Patient · 2026-10-03 09:00', body: 'online' });
  const o = app.agent(); await o.login(mail('a'));
  const r = await o.get('/app/notifications/panel?lang=ar');
  assert.match(r.text, /حجز إلكتروني جديد — Web Patient/);
  assert.match(r.text, /الساعة 09:00/);
  assert.doesNotMatch(r.text, />online</);
});
