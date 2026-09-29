// Integration test of the cashier (POS payments) and cash-drawer closings against docbook_test.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const appts = require('../src/modules/clinic/appointments.service');
const scheduling = require('../src/modules/clinic/scheduling');
const cashier = require('../src/modules/clinic/cashier.service');

let ctx; let doctorId; let serviceId; let extraId; let date; let phone = 0;

async function clinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  const today = scheduling.clinicNow('Asia/Amman').date;
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, today };
}

function nextSunday() {
  const d = new Date(`${scheduling.clinicNow('Asia/Amman').date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const times = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '14:00', '14:30', '15:00', '15:30'];
async function visit() {
  phone += 1;
  return appts.book(ctx, { doctor_id: doctorId, service_id: serviceId, patient_name: `Patient ${phone}`, patient_phone: `07900001${String(phone).padStart(2, '0')}`, appointment_date: date, appointment_time: times[phone - 1] });
}
const line = (name, qty, price, sid) => ({ name, qty: String(qty), unit_price: String(price), service_id: sid ? String(sid) : '' });

test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  ctx = await clinic('owner@cashier.test', 'Cashier Clinic');
  doctorId = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. Sami', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1', show_consultation_fee: '1' });
  serviceId = await doctors.saveService(ctx, null, { name: 'Check-up', price: '25', duration_minutes: '30', is_active: '1', show_price: '1' });
  extraId = await doctors.saveService(ctx, null, { name: 'Dressing', price: '3.5', duration_minutes: '15', is_active: '1', show_price: '1' });
  date = nextSunday();
});

test.after(() => knex.destroy());

test('bill maths: fixed discount becomes a percentage, percent discount becomes an amount', () => {
  const a = cashier.computeBill({ items: [{ name: 'A', qty: 1, unit_price: 25 }, { name: 'B', qty: 2, unit_price: 3.5 }], discount_type: 'amount', discount_value: 2 }, 'JOD');
  assert.deepEqual([a.subtotal, a.discountAmount, a.total, a.discountPercent], [32, 2, 30, 6.25]);
  const b = cashier.computeBill({ items: [{ name: 'A', qty: 3, unit_price: 10 }], discount_type: 'percent', discount_value: 10 }, 'JOD');
  assert.deepEqual([b.subtotal, b.discountAmount, b.total, b.discountPercent], [30, 3, 27, 10]);
  assert.throws(() => cashier.computeBill({ items: [{ name: 'A', qty: 1, unit_price: 5 }], discount_type: 'amount', discount_value: 6 }, 'JOD'), { code: 'VALIDATION_FAILED' });
});

test('pay with extra lines and a fixed discount stores net, discount %, items, received and change', async () => {
  const id = await visit();
  const r = await cashier.pay(ctx, id, {
    items: [line('Check-up', 1, 25, serviceId), line('Dressing', 2, 3.5, extraId), line('Bandage', 1, 1.25)],
    discount_type: 'amount', discount_value: '3.25', payment_method: 'cash', amount_received: '50',
    // client totals are ignored:
    total: '1', subtotal: '1',
  });
  const inv = await knex('invoices').where({ id: r.id }).first();
  assert.equal(Number(inv.subtotal), 33.25);
  assert.equal(Number(inv.discount_amount), 3.25);
  assert.equal(Number(inv.amount), 30);
  assert.equal(Number(inv.discount_percent), 9.77);
  assert.equal(Number(inv.amount_received), 50);
  assert.equal(Number(inv.change_due), 20);
  assert.equal(inv.service_name, 'Check-up', 'the booked service name is kept for commission overrides');
  assert.equal(inv.items.length, 3);
  assert.deepEqual(inv.items[1], { name: 'Dressing', qty: 2, unitPrice: 3.5, total: 7, serviceId: extraId });
  const a = await knex('appointments').where({ id }).first();
  assert.equal(a.payment_status, 'paid');
  assert.equal(a.status, 'completed');
  assert.equal(Number(a.amount_due), 30);
});

test('cash below the total is refused; card payments need no amount received', async () => {
  const id = await visit();
  await assert.rejects(cashier.pay(ctx, id, { items: [line('Check-up', 1, 25)], payment_method: 'cash', amount_received: '20' }), { code: 'CASH_SHORT' });
  await assert.rejects(cashier.pay(ctx, id, { items: [line('X', 0, 25)], payment_method: 'cash' }), { code: 'VALIDATION_FAILED' });
  await assert.rejects(cashier.pay(ctx, id, { items: [line('X', 1, -5)], payment_method: 'cash' }), { code: 'VALIDATION_FAILED' });
  await assert.rejects(cashier.pay(ctx, id, { items: [], payment_method: 'cash' }), { code: 'VALIDATION_FAILED' });
  assert.equal((await knex('appointments').where({ id }).first()).payment_status, 'unpaid');
  const r = await cashier.pay(ctx, id, { items: [line('Check-up', 1, 25)], payment_method: 'card' });
  const inv = await knex('invoices').where({ id: r.id }).first();
  assert.equal(inv.amount_received, null);
  assert.equal(inv.change_due, null);
});

test('a visit cannot be paid twice, even by two cashiers at the same moment', async () => {
  const id = await visit();
  const body = { items: [line('Check-up', 1, 25)], payment_method: 'cash' };
  const results = await Promise.allSettled([cashier.pay(ctx, id, body), cashier.pay(ctx, id, body)]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(results.find((x) => x.status === 'rejected').reason.code, 'ALREADY_PAID');
  await assert.rejects(cashier.pay(ctx, id, body), { code: 'ALREADY_PAID' });
  const [{ n }] = await knex('invoices').where({ appointment_id: id }).count({ n: '*' });
  assert.equal(Number(n), 1);
});

test('expected cash counts only cash receipts after the previous closing; variance = counted − expected', async () => {
  const before = await cashier.openPeriod(ctx);
  // So far: 30 (cash) + 25 (cash, double-pay test) are cash; the 25 card payment is not.
  assert.equal(before.expected, 55);
  assert.equal(before.count, 2);
  const first = await cashier.close(ctx, { counted_cash: '54', notes: 'shift 1', seen_expected: String(before.expected), seen_count: String(before.count) });
  assert.equal(first.variance, -1);
  const row = await knex('cash_closings').where({ id: first.id }).first();
  assert.equal(Number(row.expected_cash), 55);
  assert.equal(Number(row.counted_cash), 54);
  assert.equal(row.invoice_count, 2);

  const empty = await cashier.openPeriod(ctx);
  assert.equal(empty.expected, 0);
  assert.equal(empty.start.getTime(), new Date(row.period_end).getTime(), 'the next period starts where the closing ended');

  await cashier.pay(ctx, await visit(), { items: [line('Check-up', 1, 25)], payment_method: 'cash', amount_received: '30' });
  await cashier.pay(ctx, await visit(), { items: [line('Check-up', 1, 25)], payment_method: 'bank_transfer' });
  const now = await cashier.openPeriod(ctx);
  assert.equal(now.expected, 25);
  assert.equal(now.count, 1);

  // A stale screen (a receipt arrived while counting) is refused.
  await assert.rejects(cashier.close(ctx, { counted_cash: '25', seen_expected: '0', seen_count: '0' }), { code: 'DRAWER_CHANGED' });
  const second = await cashier.close(ctx, { counted_cash: '26.5', seen_expected: '25', seen_count: '1' });
  assert.equal(second.variance, 1.5);
  const list = await cashier.listClosings(ctx);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, second.id);
});
