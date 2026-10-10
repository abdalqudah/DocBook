// The cash screen lists only patients who actually came (checked in / with the doctor / finished) and today's
// receipts — not booked patients who have not arrived, nor imported visits marked done without an arrival.
// An assistant / nurse tied to a clinic (room) number sees the appointments of the doctors working in that room.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const cashier = require('../src/modules/clinic/cashier.service');
const appts = require('../src/modules/clinic/appointments.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `car-${k}-${tag}@t.test`;
let app; let b; let ctx; let d1; let d2; let today;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const u = await knex.transaction(async (trx) => { const id = await auth.createUser(trx, { name: 'Owner', email: mail('owner'), password: 'Passw0rd!x' }); await businesses.create(id, { name: `Cash ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx); return id; });
  await knex('users').where({ id: u }).update({ email_verified_at: new Date() });
  b = (await knex('users').where({ id: u }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
  today = scheduling.clinicNow('Asia/Amman').date;
  ctx = { businessId: b, userId: u, roleKey: 'owner', permissions: await rbac.getUserPermissions(b, u), locale: 'en', timezone: 'Asia/Amman', currency: 'JOD', today, workBranch: '' };
  const wh = JSON.stringify(scheduling.defaultWorkingHours());
  [d1] = await knex('doctors').insert({ business_id: b, full_name: 'Dr One', is_active: true, working_hours: wh, slot_duration_minutes: 30, room: '1' });
  [d2] = await knex('doctors').insert({ business_id: b, full_name: 'Dr Two', is_active: true, working_hours: wh, slot_duration_minutes: 30, room: '2' });
  const ap = { business_id: b, appointment_date: today, appointment_type: 'in_person', source: 'staff', payment_status: 'unpaid' };
  await knex('appointments').insert([
    { ...ap, doctor_id: d1, patient_name: 'Booked Only', appointment_time: '09:00', status: 'confirmed' },
    { ...ap, doctor_id: d1, patient_name: 'Came In', appointment_time: '09:30', status: 'confirmed', checked_in: true, arrived_at: new Date() },
    { ...ap, doctor_id: d1, patient_name: 'Done No Arrival', appointment_time: '10:00', status: 'completed' },
    { ...ap, doctor_id: d2, patient_name: 'Finished', appointment_time: '10:30', status: 'completed', checked_in: true, arrived_at: new Date(), doctor_finished_at: new Date(), amount_due: 15 },
  ]);
  // a nurse of clinic (room) 2
  const role = await rbac.getRoleByKey(b, 'nurse');
  const nid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Nurse Two', email: mail('nurse'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: nid }).update({ last_business_id: b, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: b, user_id: nid, role_id: role.id, room: '2' });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('the cash screen shows only patients who came in', async () => {
  const s = await cashier.screen(ctx);
  const names = s.cols.flatMap((c) => c.visits.map((v) => v.patient_name)).sort();
  assert.deepEqual(names, ['Came In', 'Finished']);
  assert.equal(s.ready, 1);
  const q = (await cashier.queue(ctx)).map((v) => v.patient_name).sort();
  assert.deepEqual(q, ['Came In', 'Finished']);
});

test("a nurse of a clinic (room) sees that room's doctors' appointments — the day's room wins over the usual one", async () => {
  const nctx = { ...ctx, roleKey: 'nurse', myRoom: '2' };
  let rows = await appts.list(nctx, { from: today, to: today });
  assert.deepEqual(rows.map((r) => r.patient_name), ['Finished']);
  // today reception moves Dr One into clinic 2 and Dr Two into clinic 3
  await knex('doctor_day_rooms').insert([{ business_id: b, doctor_id: d1, day: today, room: '2' }, { business_id: b, doctor_id: d2, day: today, room: '3' }]);
  rows = await appts.list(nctx, { from: today, to: today });
  assert.deepEqual(rows.map((r) => r.patient_name).sort(), ['Booked Only', 'Came In', 'Done No Arrival']);
  const o = app.agent(); await o.login(mail('nurse'));
  const r = await o.get('/app/front-desk?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Came In/); assert.doesNotMatch(r.text, /Finished/);
  await knex('doctor_day_rooms').where({ business_id: b }).del();
});
