// Printing (day sheet, patient list, patient file summary), staff chat inside one clinic, and medical reps reaching
// every clinic open to them: exact rep times where set, otherwise a request at a suggested time within the doctor's
// working hours (the clinic decides). Through HTTP against the test database.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `sr-${k}-${tag}@t.test`;
let app; let businessId; let otherBiz; let patientId; let doc; let today; let ownerId; let nurseId; let repUser; let vendorId;

async function user(k, name) {
  const id = await knex.transaction((trx) => auth.createUser(trx, { name, email: mail(k), password: 'Passw0rd!x' }));
  await knex('users').where({ id }).update({ email_verified_at: new Date() });
  return id;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ownerId = await user('owner', 'Owner One');
  await knex.transaction((trx) => businesses.create(ownerId, { name: `Reps Clinic ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  businessId = (await knex('users').where({ id: ownerId }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug: `sr-${tag}`.slice(0, 40), directory_listed: true, booking_enabled: true });
  const o2 = await user('owner2', 'Owner Two');
  await knex.transaction((trx) => businesses.create(o2, { name: `Other ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  otherBiz = (await knex('users').where({ id: o2 }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: otherBiz }).update({ onboarding_completed_at: new Date() });
  // a nurse on the team (for the chat)
  nurseId = await user('nurse', 'Nurse Noor');
  const role = await knex('roles').where({ business_id: businessId, key: 'nurse' }).first('id') || await knex('roles').where({ business_id: businessId }).whereNot('key', 'owner').first('id');
  await knex('memberships').insert({ business_id: businessId, user_id: nurseId, role_id: role.id, status: 'active' });
  await knex('users').where({ id: nurseId }).update({ last_business_id: businessId });
  if (rbac.forget) rbac.forget(businessId);
  today = scheduling.clinicNow('Asia/Amman').date;
  const wh = scheduling.defaultWorkingHours(); // 09:00–17:00, Friday off
  [doc] = await knex('doctors').insert({ business_id: businessId, full_name: 'Dr Hours', is_active: true, working_hours: JSON.stringify(wh), slot_duration_minutes: 30 });
  [patientId] = await knex('patients').insert({ business_id: businessId, full_name: 'Print Patient', phone: '0793333333', allergies: 'Penicillin' });
  await knex('appointments').insert({ business_id: businessId, doctor_id: doc, patient_id: patientId, patient_name: 'Print Patient', patient_phone: '0793333333', appointment_date: today, appointment_time: '10:00', status: 'confirmed', appointment_type: 'in_person', source: 'staff' });
  // an active rep
  repUser = await user('rep', 'Rep Rami');
  [vendorId] = await knex('vendors').insert({ type: 'rep', name: `Pharma ${tag}`, email: mail('vendor'), phone: '0790000000', status: 'active', approved_at: new Date() });
  await knex('vendor_users').insert({ vendor_id: vendorId, user_id: repUser, role: 'owner' });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('printing: day sheet, patient list and patient file summary on the letterhead', async () => {
  const o = app.agent(); await o.login(mail('owner'));
  let r = await o.get(`/app/appointments/print?from=${today}&to=${today}&print=1&lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /print-letterhead/);
  assert.match(r.text, /Print Patient/);
  r = await o.get('/app/appointments?lang=en');
  assert.match(r.text, /\/app\/appointments\/print\?/, 'print button on the appointments page');
  r = await o.get('/app/patients/print?print=1&q=Print');
  assert.equal(r.status, 200);
  assert.match(r.text, /Print Patient/);
  r = await o.get(`/app/patients/${patientId}/summary?print=1&lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Patient file summary/);
  assert.match(r.text, /Penicillin/);
  r = await o.get(`/app/patients/${patientId}?lang=en`);
  assert.match(r.text, new RegExp(`/app/patients/${patientId}/summary`));
});

test('staff chat: room and one-to-one inside the clinic; unread badge; other clinics never see it', async () => {
  const owner = app.agent(); await owner.login(mail('owner'));
  let r = await owner.get('/app/chat?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Clinic room/);
  const roomId = Number(r.text.match(/data-chat="(\d+)"/)[1]);
  r = await owner.submit('/app/chat', `/app/chat/${roomId}`, { body: 'Good morning team' });
  assert.equal(r.status, 302);
  r = await owner.get(`/app/chat?u=${nurseId}`);
  assert.equal(r.status, 302);
  const dm = Number(r.location.match(/c=(\d+)/)[1]);
  await owner.submit(`/app/chat?c=${dm}`, `/app/chat/${dm}`, { body: 'Please prepare room 2' });
  const nurse = app.agent(); await nurse.login(mail('nurse'));
  r = await nurse.get('/app/chat/unread');
  assert.equal(JSON.parse(r.text).unread, 2);
  r = await nurse.get(`/app/chat/${dm}/messages?after=0`, { accept: 'application/json' });
  assert.equal(JSON.parse(r.text).data[0].body, 'Please prepare room 2');
  r = await nurse.get('/app/chat/unread');
  assert.equal(JSON.parse(r.text).unread, 1, 'reading the conversation clears its count');
  // empty messages refused; another clinic's owner cannot open or write to this clinic's conversations
  await owner.submit(`/app/chat?c=${dm}`, `/app/chat/${dm}`, { body: '   ' });
  assert.equal(Number((await knex('staff_chat_messages').where({ chat_id: dm }).count({ n: '*' }))[0].n), 1);
  const stranger = app.agent(); await stranger.login(mail('owner2'));
  r = await stranger.get(`/app/chat/${dm}/messages`);
  assert.equal(r.status, 404);
  r = await stranger.get(`/app/chat?u=${nurseId}`);
  assert.equal(r.status, 404);
});

test('reps: a listed clinic without rep times takes a request within the doctor hours; the clinic sees it; it can be turned off', async () => {
  const rep = app.agent(); await rep.login(mail('rep'));
  let r = await rep.get('/vendor/visits/new?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`Reps Clinic ${tag}`));
  assert.match(r.text, /Request a time/);
  r = await rep.get(`/vendor/visits/new?clinic=${businessId}&lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Dr Hours/);
  assert.match(r.text, /09:00–17:00/);
  // next Sunday (working day) at 08:00 → outside hours; at 11:00 → accepted
  const d = new Date(`${today}T00:00:00Z`); do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 0);
  const sunday = d.toISOString().slice(0, 10);
  r = await rep.submit(`/vendor/visits/new?clinic=${businessId}`, '/vendor/visits', { business_id: String(businessId), doctor_id: String(doc), visit_date: sunday, visit_time: '08:00', purpose: 'New product' });
  assert.ok(!(await knex('rep_visits').where({ business_id: businessId, vendor_id: vendorId }).first()), 'outside working hours refused');
  r = await rep.submit(`/vendor/visits/new?clinic=${businessId}`, '/vendor/visits', { business_id: String(businessId), doctor_id: String(doc), visit_date: sunday, visit_time: '11:00', purpose: 'New product' });
  assert.equal(r.status, 302);
  const v = await knex('rep_visits').where({ business_id: businessId, vendor_id: vendorId }).first();
  assert.equal(v.status, 'requested');
  assert.equal(Boolean(v.flexible), true);
  const owner = app.agent(); await owner.login(mail('owner'));
  r = await owner.get('/app/rep-visits?lang=en');
  assert.match(r.text, /Suggested time/);
  // turned off → the clinic disappears for reps
  await knex('businesses').where({ id: businessId }).update({ rep_requests_off: true });
  r = await rep.get('/vendor/visits/new?lang=en');
  assert.doesNotMatch(r.text, new RegExp(`Reps Clinic ${tag}`));
});

test('sidebar: reps sit under patients with the offers next to them; the home page invites reps to register', async () => {
  const o = app.agent(); await o.login(mail('owner'));
  const r = await o.get('/app/rep-visits?lang=en');
  const i = r.text.indexOf('href="/app/patients"'); const j = r.text.indexOf('Medical reps');
  assert.ok(i > 0 && j > i, 'reps after patients in the sidebar');
  assert.match(r.text, /href="\/app\/marketplace"/);
  const home = await app.agent().get('/?lang=ar');
  assert.match(home.text, /href="\/vendors\/signup"/);
  assert.match(home.text, /href="\/vendors"/);
});
