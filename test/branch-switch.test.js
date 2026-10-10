// A clinic with branches: the account menu lists the branches; choosing one makes it the calendar's and the
// appointments list's default (the page's own branch filter still wins); only this clinic's branches are accepted.
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
const mail = `bs-${tag}@t.test`;
let app; let b; let branch; let other;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const u = await knex.transaction(async (trx) => { const id = await auth.createUser(trx, { name: 'Owner', email: mail, password: 'Passw0rd!x' }); await businesses.create(id, { name: `Main ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx); return id; });
  await knex('users').where({ id: u }).update({ email_verified_at: new Date() });
  b = (await knex('users').where({ id: u }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
  [branch] = await knex('clinic_branches').insert({ business_id: b, name: `العبدلي ${tag}`, is_active: true });
  const ob = (await knex('businesses').insert({ name: 'Other', slug: `bso${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }))[0];
  [other] = await knex('clinic_branches').insert({ business_id: ob, name: 'Not mine', is_active: true });
  const wh = JSON.stringify(scheduling.defaultWorkingHours());
  const [d1] = await knex('doctors').insert({ business_id: b, full_name: 'Dr Main', is_active: true, working_hours: wh, slot_duration_minutes: 30 });
  const [d2] = await knex('doctors').insert({ business_id: b, full_name: 'Dr Abdali', is_active: true, working_hours: wh, slot_duration_minutes: 30, branch_id: branch });
  const date = scheduling.clinicNow('Asia/Amman').date;
  const ap = { business_id: b, appointment_date: date, status: 'confirmed', appointment_type: 'in_person', source: 'staff' };
  await knex('appointments').insert([{ ...ap, doctor_id: d1, patient_name: 'Main Patient', appointment_time: '10:00' }, { ...ap, doctor_id: d2, branch_id: branch, patient_name: 'Abdali Patient', appointment_time: '11:00' }]);
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('the account menu switches the branch; the calendar and list follow it', async () => {
  const o = app.agent(); await o.login(mail);
  let r = await o.get('/app/appointments?view=list&lang=en');
  assert.match(r.text, /data-branch-switch/); assert.match(r.text, new RegExp(`العبدلي ${tag}`));
  assert.match(r.text, /Main Patient/); assert.match(r.text, /Abdali Patient/);
  r = await o.submit('/app/appointments?view=list', '/workspaces/branch', { branch: String(branch), return_to: '/app/appointments' });
  assert.equal(r.status, 302); assert.equal(r.location, '/app/appointments');
  r = await o.get('/app/appointments?view=list&lang=en');
  assert.match(r.text, /Abdali Patient/); assert.doesNotMatch(r.text, /Main Patient/);
  r = await o.get('/app/appointments?view=list&branch=&lang=en');
  assert.match(r.text, /Main Patient/, 'the page filter still wins (all branches)');
  // another clinic's branch: refused
  r = await o.submit('/app/appointments?view=list', '/workspaces/branch', { branch: String(other) });
  assert.equal(r.status, 403);
  r = await o.submit('/app/appointments?view=list', '/workspaces/branch', { branch: 'main', return_to: '//evil.example/x' });
  assert.equal(r.location, '/app/appointments');
  r = await o.get('/app/appointments?view=list&lang=en');
  assert.match(r.text, /Main Patient/); assert.doesNotMatch(r.text, /Abdali Patient/);
});
