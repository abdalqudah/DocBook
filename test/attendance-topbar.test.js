// Attendance in the top bar: every staff member except the owner sees a clock; it clocks in / out from any page and
// comes back to that page; the dot shows "clocked in". A QR-only clinic shows a note instead of the button.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ownerEmail = `att-own-${tag}@t.test`; const recEmail = `att-rec-${tag}@t.test`;
let app; let bid; let recId;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Owner', email: ownerEmail, password: 'Passw0rd!x' }));
  bid = await knex.transaction((trx) => businesses.create(uid, { name: 'Att clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('businesses').where({ id: bid }).update({ onboarding_completed_at: new Date() });
  recId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Reception', email: recEmail, password: 'Passw0rd!x' }));
  await knex('users').whereIn('id', [uid, recId]).update({ email_verified_at: new Date(), last_business_id: bid });
  const role = await rbac.getRoleByKey(bid, 'receptionist');
  await knex('memberships').insert({ business_id: bid, user_id: recId, role_id: role.id, status: 'active' });
  rbac.invalidate(bid);
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('staff clock in and out from the top bar; the owner has no clock there', async () => {
  const o = app.agent(); await o.login(ownerEmail);
  assert.doesNotMatch((await o.get('/app')).text, /class="dropdown att-dd"/);
  const r = app.agent(); await r.login(recEmail);
  let page = await r.get('/app/appointments');
  assert.match(page.text, /class="dropdown att-dd"/);
  assert.doesNotMatch(page.text, /att-btn is-in/);
  let res = await r.post('/app/attendance/clock', { _csrf: r.csrf(page.text), expect: 'in', _return: '/app/appointments' });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/app/appointments', 'back to the page the button was on');
  assert.ok(await knex('attendance_records').where({ business_id: bid, user_id: recId }).whereNull('clock_out').first('id'));
  page = await r.get('/app/appointments');
  assert.match(page.text, /att-btn is-in/);
  // an outside address is never followed
  res = await r.post('/app/attendance/clock', { _csrf: r.csrf(page.text), expect: 'out', _return: '//evil.example/x' });
  assert.equal(res.location, '/app/attendance');
  assert.ok(await knex('attendance_records').where({ business_id: bid, user_id: recId }).whereNotNull('clock_out').first('id'));
  // QR-only clinic: a note, no button
  await knex('attendance_settings').insert({ business_id: bid, qr_only: true }).onConflict('business_id').merge();
  page = await r.get('/app');
  assert.match(page.text, /att-note/);
  assert.doesNotMatch(page.text, /class="btn btn-primary att-go"/);
});
