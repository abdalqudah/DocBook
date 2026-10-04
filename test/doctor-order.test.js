// The doctors' order in the calendar: a doctor's column moved onto another's place reorders the clinic's doctors.
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
let app; let bid; const ids = {};
test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Owner', email: `ord-${tag}@t.test`, password: 'Passw0rd!x' }));
  bid = await knex.transaction((trx) => businesses.create(uid, { name: 'Order clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('users').where({ id: uid }).update({ email_verified_at: new Date() });
  await knex('businesses').where({ id: bid }).update({ onboarding_completed_at: new Date() });
  for (const n of ['A', 'B', 'C', 'D']) [ids[n]] = await knex('doctors').insert({ business_id: bid, full_name: `Dr ${n} ${tag}`, is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()) }); // eslint-disable-line no-await-in-loop
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

const order = async () => (await knex('doctors').where({ business_id: bid, is_active: true }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }]).pluck('id'));

test('drag a doctor onto another doctor\'s place', async () => {
  const a = app.agent(); await a.login(`ord-${tag}@t.test`);
  const cal = await a.get('/app/appointments');
  assert.match(cal.text, /data-cal-grip/);
  const post = (src, dst) => a.post('/app/appointments/doctor-order', { _csrf: a.csrf(cal.text), doctor_id: String(src), target_id: String(dst) }, { accept: 'application/json' });
  let r = await post(ids.D, ids.A); // D moved back to A's place
  assert.equal(r.status, 200);
  assert.deepEqual(await order(), [ids.D, ids.A, ids.B, ids.C]);
  r = await post(ids.A, ids.C); // A moved along to C's place
  assert.deepEqual(await order(), [ids.D, ids.B, ids.C, ids.A]);
  // The calendar shows them in that order.
  const page = await a.get('/app/appointments');
  const pos = (n) => page.text.indexOf(`Dr ${n} ${tag}`);
  assert.ok(pos('D') < pos('B') && pos('B') < pos('C') && pos('C') < pos('A'));
  // Another clinic's doctor: refused, nothing changes.
  const [otherClinic] = await knex('businesses').insert({ name: 'Other', slug: `ord-o-${tag}`.slice(0, 40), currency: 'JOD', timezone: 'Asia/Amman', status: 'active' });
  const [other] = await knex('doctors').insert({ business_id: otherClinic, full_name: 'X', is_active: true });
  r = await post(other, ids.A);
  assert.equal(r.status, 404);
  assert.deepEqual(await order(), [ids.D, ids.B, ids.C, ids.A]);
  assert.ok(await knex('audit_logs').where({ business_id: bid, action: 'doctors.reordered' }).first('id'));
});
