// Waiting-room screen: the clinic adds a screen (secret link, no sign-in), the TV shows who goes in now with the
// room number, who is next and two waiting (short names by default), only this clinic's patients; a new link stops
// the old one; the JSON changes its signature when the queue moves (the screen chimes).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const secrets = require('../src/core/secrets');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const scheduling = require('../src/modules/clinic/scheduling');
const queue = require('../src/modules/queue/queue.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `q-${k}-${tag}@t.test`;
let app; let businessId; let doc; const ids = {};

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const mk = async (k) => {
    const userId = await knex.transaction(async (trx) => {
      const id = await auth.createUser(trx, { name: 'Owner', email: mail(k), password: 'Passw0rd!x' });
      await businesses.create(id, { name: `Queue ${k}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
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
  [doc] = await knex('doctors').insert({ business_id: businessId, full_name: 'Dr Queue', is_active: true, room: '3', working_hours: JSON.stringify(scheduling.defaultWorkingHours()), slot_duration_minutes: 30 });
  const add = async (b, name, mins, extra = {}) => (await knex('appointments').insert({ business_id: b, doctor_id: b === businessId ? doc : null, patient_name: name, patient_phone: '0790000000', appointment_date: today, appointment_time: '09:00', status: 'confirmed', appointment_type: 'in_person', source: 'staff', checked_in: true, arrived_at: new Date(Date.now() - mins * 60_000), ...extra }))[0];
  ids.inRoom = await add(businessId, 'Sara Ahmad Khalil', 30, { with_doctor: true, called_at: new Date(Date.now() - 60_000) });
  ids.first = await add(businessId, 'Omar Yousef Haddad', 25);
  ids.second = await add(businessId, 'Lina Saleh', 20);
  ids.third = await add(businessId, 'Mona Ali', 10);
  ids.fourth = await add(businessId, 'Zaid Nasser', 5);
  ids.notArrived = await add(businessId, 'Not Arrived', 0, { checked_in: false, arrived_at: null });
  ids.other = await add(otherBiz, 'Other Clinic Patient', 40);
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('short names', () => {
  assert.equal(queue.shortName('Omar Yousef Haddad'), 'Omar H.');
  assert.equal(queue.shortName('محمد أحمد سالم'), 'محمد س.');
  assert.equal(queue.shortName('Lina'), 'Lina');
  assert.equal(queue.shortName('ليان عمر الخطيب'), 'ليان خ.');
});

test('waiting-room screen: add, open by its secret link, now / next / waiting with the room; new link stops the old one', async () => {
  const o = app.agent(); await o.login(mail('a'));
  let r = await o.get('/app/queue-screens?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Waiting-room screens/);
  r = await o.submit('/app/queue-screens', '/app/queue-screens', { name: 'Hall TV', name_style: 'short' });
  assert.equal(r.status, 302);
  const k = await knex('queue_screens').where({ business_id: businessId }).first();
  assert.ok(k && k.token_hash && k.name === 'Hall TV');
  const token = secrets.decrypt(k.token_enc);

  const tv = app.agent(); // the TV: no sign-in
  r = await tv.get(`/queue/${token}?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Please go in/);
  assert.match(r.text, /Sara K\./);
  assert.match(r.text, /Room 3/);
  assert.ok(!/Sara Ahmad Khalil/.test(r.text), 'short names by default');
  r = await tv.get(`/queue/${token}/data`);
  const b = JSON.parse(r.text).data;
  assert.equal(b.now.id, ids.inRoom);
  assert.equal(b.next.id, ids.first, 'next = waiting the longest');
  assert.equal(b.next.room, '3');
  assert.deepEqual(b.waiting.map((p) => p.id), [ids.second, ids.third]);
  assert.equal(b.more, 1);
  assert.ok(!JSON.stringify(b).includes('Other Clinic') && !JSON.stringify(b).includes('Not Arrived'));

  // Reception sends the next patient in: the queue moves, the signature changes (the screen chimes).
  r = await o.submit('/app/front-desk', `/app/front-desk/${ids.first}/call-in`, { on: '1' });
  assert.equal(r.status, 302);
  const b2 = JSON.parse((await tv.get(`/queue/${token}/data`)).text).data;
  assert.equal(b2.now.id, ids.first);
  assert.equal(b2.next.id, ids.second);
  assert.notEqual(b2.sig, b.sig);

  // Full names when the clinic chooses them.
  r = await o.submit('/app/queue-screens', `/app/queue-screens/${k.id}`, { name: 'Hall TV', name_style: 'full', is_active: '1' });
  assert.equal(r.status, 302);
  assert.match((await tv.get(`/queue/${token}/data`)).text, /Omar Yousef Haddad/);

  // New link: the old one stops at once.
  r = await o.submit('/app/queue-screens', `/app/queue-screens/${k.id}/regenerate`, {});
  assert.equal(r.status, 302);
  r = await tv.get(`/queue/${token}/data`);
  assert.equal(r.status, 404);
  assert.notEqual((await tv.get(`/queue/${token}`)).status, 200);
  assert.equal((await tv.get('/queue/not-a-real-token-at-all-xxxxxxxx/data')).status, 404);
});

test('doctor room number is saved from the doctor form', async () => {
  const o = app.agent(); await o.login(mail('a'));
  const d = await knex('doctors').where({ id: doc }).first();
  const r = await o.submit(`/app/doctors/${doc}/edit`, `/app/doctors/${doc}/edit`, { full_name: d.full_name, room: '2B', slot_duration_minutes: '30', is_active: '1', hours_mode: 'clinic' });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  assert.equal((await knex('doctors').where({ id: doc }).first('room')).room, '2B');
});

test('platform admin: clinic areas switch the waiting screen and team chat off; overview and landing show the new features', async () => {
  const adminMail = `q-admin-${tag}@t.test`;
  const adminId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Admin', email: adminMail, password: 'Passw0rd!x' }));
  await knex('users').where({ id: adminId }).update({ is_platform_admin: true, email_verified_at: new Date() });
  const ad = app.agent(); await ad.login(adminMail);
  let r = await ad.get('/admin?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Backups up to date/);
  assert.match(r.text, /Waiting screens on now/);
  r = await ad.get('/admin/clinics?lang=en');
  assert.match(r.text, /Last backup/);
  r = await ad.get(`/admin/clinics/${businessId}?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Clinic areas/);
  assert.match(r.text, /name="queue_screens"/);
  // Everything ticked except the waiting screen and the team chat.
  const keep = ['online_consultations', 'billing', 'doctor_payroll', 'staff_salaries', 'finance', 'supplies', 'marketplace', 'certificates', 'reviews', 'specialty_records', 'ai_assistant', 'attendance', 'reports', 'patient_sharing'];
  r = await ad.submit(`/admin/clinics/${businessId}`, `/admin/clinics/${businessId}/modules`, Object.fromEntries(keep.map((k) => [k, '1'])));
  assert.equal(r.status, 302);
  const k = await knex('queue_screens').where({ business_id: businessId }).first();
  const token = secrets.decrypt(k.token_enc);
  assert.equal((await app.agent().get(`/queue/${token}/data`)).status, 404, 'screen off with the area');
  const o = app.agent(); await o.login(mail('a'));
  r = await o.get('/app/front-desk?lang=en');
  assert.ok(!/href="\/app\/queue-screens"/.test(r.text) && !/href="\/app\/chat"/.test(r.text), 'no waiting-screen button or chat icon');
  assert.notEqual((await o.get('/app/queue-screens')).status, 200);
  // Back on.
  r = await ad.submit(`/admin/clinics/${businessId}`, `/admin/clinics/${businessId}/modules`, Object.fromEntries([...keep, 'queue_screens', 'staff_chat'].map((x) => [x, '1'])));
  assert.equal((await app.agent().get(`/queue/${token}/data`)).status, 200);

  r = await app.agent().get('/?lang=en');
  assert.match(r.text, /Waiting-room screen/);
  assert.match(r.text, /An encrypted backup per clinic/);
  assert.match(r.text, /What do I need for the waiting-room screen\?/);
});
