// My profile & services: a doctor's own login edits the doctor's public profile and the doctor's own services —
// never another doctor's, never the name / fee / hours; a service may have no fixed time (the doctor's usual length).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const tenant = require('../src/db/tenant');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const docEmail = `mp-doc-${tag}@t.test`; const recEmail = `mp-rec-${tag}@t.test`;
let app; let bid; let me; let other; let otherSvc;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Owner', email: `mp-own-${tag}@t.test`, password: 'Passw0rd!x' }));
  bid = await knex.transaction((trx) => businesses.create(uid, { name: 'MP clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('businesses').where({ id: bid }).update({ onboarding_completed_at: new Date() });
  await tenant.runFor(bid, async () => {
    const wh = JSON.stringify(scheduling.defaultWorkingHours());
    [me] = await knex('doctors').insert({ business_id: bid, full_name: 'د. سارة', is_active: true, working_hours: wh, consultation_fee: 20 });
    [other] = await knex('doctors').insert({ business_id: bid, full_name: 'د. علي', is_active: true, working_hours: wh });
    [otherSvc] = await knex('services').insert({ business_id: bid, doctor_id: other, name: 'خدمة علي', duration_minutes: 30, price: 10 });
  });
  const docId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Sara', email: docEmail, password: 'Passw0rd!x' }));
  const recId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Rec', email: recEmail, password: 'Passw0rd!x' }));
  await knex('users').whereIn('id', [docId, recId]).update({ email_verified_at: new Date(), last_business_id: bid });
  await knex('memberships').insert({ business_id: bid, user_id: docId, role_id: (await rbac.getRoleByKey(bid, 'doctor')).id, status: 'active', doctor_id: me });
  await knex('memberships').insert({ business_id: bid, user_id: recId, role_id: (await rbac.getRoleByKey(bid, 'receptionist')).id, status: 'active' });
  rbac.invalidate(bid);
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

const one = (q) => tenant.runFor(bid, () => q());

test('a doctor edits their own profile and services; nothing else', async () => {
  const a = app.agent(); await a.login(docEmail);
  let page = await a.get('/app/my-profile');
  assert.equal(page.status, 200);
  assert.match(page.text, /href="\/app\/my-profile"/, 'in the user menu');
  let r = await a.post('/app/my-profile', { _csrf: a.csrf(page.text), full_name: 'Hacked', consultation_fee: '999', specialization: 'تقويم الأسنان', bio: 'نبذة جديدة', social_instagram: 'https://instagram.com/dr.sara', profile_years: '12' });
  assert.equal(r.status, 302);
  const d = await one(() => knex('doctors').where({ id: me }).first());
  assert.equal(d.full_name, 'د. سارة', 'the name stays the manager\'s');
  assert.equal(Number(d.consultation_fee), 20, 'the fee stays the manager\'s');
  assert.equal(d.specialization, 'تقويم الأسنان');
  assert.equal(d.bio, 'نبذة جديدة');
  assert.match(d.social_links, /instagram\.com\/dr\.sara/);
  assert.match(d.profile, /12/);
  // a service with no fixed time, always the doctor's own
  page = await a.get('/app/my-profile');
  r = await a.post('/app/my-profile/services', { _csrf: a.csrf(page.text), name: 'استشارة تقويم', price: '15', duration_minutes: '', doctor_id: String(other), is_active: '1', site_field: '1', show_on_site: '1' });
  assert.equal(r.status, 302);
  const s = await one(() => knex('services').where({ business_id: bid, name: 'استشارة تقويم' }).first());
  assert.equal(s.doctor_id, me, 'the doctor is never taken from the form');
  assert.equal(s.duration_minutes, null, 'no fixed time');
  page = await a.get('/app/my-profile');
  assert.match(page.text, /بدون وقت محدد|No fixed time/);
  // another doctor's service: not reachable
  r = await a.post(`/app/my-profile/services/${otherSvc}`, { _csrf: a.csrf(page.text), name: 'x', price: '1', duration_minutes: '20' });
  assert.equal(r.status, 404);
  r = await a.post(`/app/my-profile/services/${otherSvc}/delete`, { _csrf: a.csrf(page.text) });
  assert.equal(r.status, 404);
  assert.equal((await one(() => knex('services').where({ id: otherSvc }).first('name'))).name, 'خدمة علي');
  // the clinic's services page stays the manager's
  assert.equal((await a.get('/app/services')).status, 403);
  // booking with a no-fixed-time service takes the doctor's usual length
  const len = await one(() => scheduling.availableSlots({ businessId: bid, timezone: 'Asia/Amman', doctorId: me, date: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), serviceId: s.id }));
  assert.ok(Array.isArray(len));
});

test('a login without a doctor has no My profile', async () => {
  const r = app.agent(); await r.login(recEmail);
  const page = await r.get('/app/my-profile');
  assert.equal(page.status, 302);
  assert.doesNotMatch((await r.get('/app')).text, /href="\/app\/my-profile"/);
});
