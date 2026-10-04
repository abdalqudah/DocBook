// Many people taking the same appointment slot at the same instant: exactly one wins, every other one is told the
// time is taken — the slot lock is held until the winner's row is committed, so no one reads before it is visible.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const tenant = require('../src/db/tenant');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const scheduling = require('../src/modules/clinic/scheduling');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let bid; let docId;
let date;

test.before(async () => {
  await knex.migrate.latest();
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Owner', email: `slot-${tag}@t.test`, password: 'Passw0rd!x' }));
  bid = await knex.transaction((trx) => businesses.create(uid, { name: 'Slot clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await tenant.runFor(bid, async () => {
    [docId] = await knex('doctors').insert({ business_id: bid, full_name: 'Dr Slot', is_active: true, slot_duration_minutes: 30, working_hours: JSON.stringify(scheduling.defaultWorkingHours()) });
  });
});
test.after(async () => { await knex.destroy(); });

test('eight simultaneous bookings of one slot, five rounds: one appointment each time', async () => {
  await tenant.runFor(bid, async () => {
    let free = [];
    for (let i = 3; i < 14 && free.length < 10; i += 1) { // the first working day ahead
      date = new Date(Date.now() + i * 864e5).toISOString().slice(0, 10);
      // eslint-disable-next-line no-await-in-loop
      free = await scheduling.availableSlots({ businessId: bid, timezone: 'Asia/Amman', doctorId: docId, date });
    }
    assert.ok(free.length >= 10, 'the doctor works that day');
    for (const time of free.filter((x, i) => i % 2 === 0).slice(0, 5)) {
      const take = (n) => scheduling.withSlot({ businessId: bid, timezone: 'Asia/Amman', doctorId: docId, date, time }, (trx) => trx('appointments').insert({
        business_id: bid, doctor_id: docId, patient_name: `P${n}`, appointment_date: date, appointment_time: time, duration_minutes: 30, status: 'confirmed',
      }));
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled([0, 1, 2, 3, 4, 5, 6, 7].map(take));
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `one winner at ${time}`);
      assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'SLOT_TAKEN'));
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await knex('appointments').where({ business_id: bid, doctor_id: docId, appointment_date: date, appointment_time: time }).count({ n: '*' }).then((x) => Number(x[0].n)), 1);
    }
  });
});
