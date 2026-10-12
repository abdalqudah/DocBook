// The clinic's record-privacy rule ("only the treating doctor opens clinical notes", Settings → Privacy) over HTTP for
// the specialty records (spirometry, vitals forms… under /app/patients/:id/records): with the rule on, a nurse is
// turned away from a patient's specialty record (no content in the answer); the owner still opens it.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `privrec-${k}-${tag}@t.test`;
const MARK = `PRIVREC${tag}`;
const today = new Date().toISOString().slice(0, 10);
let app; let businessId; let patientId; let recordId;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const ownerId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Priv Owner', email: mail('owner'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: `Priv ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  ({ last_business_id: businessId } = await knex('users').where({ id: ownerId }).first('last_business_id'));
  await knex('users').where({ id: ownerId }).update({ email_verified_at: new Date() });
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), clinical_privacy: true });
  const nurseId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Priv Nurse', email: mail('nurse'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: nurseId }).update({ email_verified_at: new Date(), last_business_id: businessId });
  const role = await knex('roles').where({ business_id: businessId, key: 'nurse' }).first('id');
  await knex('memberships').insert({ business_id: businessId, user_id: nurseId, role_id: role.id, status: 'active' });
  const [doctorId] = await knex('doctors').insert({ business_id: businessId, full_name: `Dr ${tag}`, is_active: true });
  [patientId] = await knex('patients').insert({ business_id: businessId, full_name: `Patient ${tag}`, phone: '0793333333' });
  const [apptId] = await knex('appointments').insert({ business_id: businessId, patient_id: patientId, doctor_id: doctorId, patient_name: `Patient ${tag}`, patient_phone: '0793333333', appointment_date: today, appointment_time: '10:00', status: 'completed' });
  [recordId] = await knex('specialty_records').insert({ business_id: businessId, patient_id: patientId, appointment_id: apptId, doctor_id: doctorId, form_key: 'vitals', record_date: today, data: JSON.stringify({ note: MARK }), headline: `rec ${MARK}` });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('privacy on: a nurse cannot open a specialty record; the owner can', async () => {
  const nurse = app.agent(); await nurse.login(mail('nurse'));
  for (const path of [`/app/patients/${patientId}/records/vitals/${recordId}`, `/app/patients/${patientId}/records/vitals`, `/app/patients/${patientId}/records`]) {
    const r = await nurse.get(`${path}?lang=en`);
    assert.ok(r.status === 302 || r.status === 403, `${path}: ${r.status}`);
    assert.ok(!String(r.text || '').includes(MARK), `${path} leaked the record`);
  }
  const owner = app.agent(); await owner.login(mail('owner'));
  const r = await owner.get(`/app/patients/${patientId}/records?lang=en`);
  assert.equal(r.status, 200, 'the owner opens the patient\'s records');
});
