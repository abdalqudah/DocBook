// Regression tests for the calculation audit: rounding at the currency's precision, month boundaries in the
// clinic's time zone (also with daylight saving), stored figures for paid months, P&L-consistent salary costs,
// shares adding up, subscription periods, and dates / ages on the clinic's own calendar.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const lib = require('../src/modules/clinic/records.lib');
const rules = require('../src/modules/clinic/money-rules');
const fmt = require('../src/core/format');
const m = require('../src/modules/finance/math');
const subs = require('../src/modules/subscriptions/subscriptions.service');
const bank = require('../src/modules/payouts/bank.service');
const recurring = require('../src/modules/expenses/recurring.service');
const payroll = require('../src/modules/clinic/payroll.service');
const pnl = require('../src/modules/finance/pnl.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let doc;
test.before(async () => {
  await knex.migrate.latest();
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: `ma-${tag}@t.test`, password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Math clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: B } = await knex('users').where({ id: userId }).first('last_business_id');
  ctx = { businessId: B, userId, userName: 'Owner', permissions: await rbac.getUserPermissions(B, userId), currency: 'JOD', timezone: 'Asia/Amman', today: '2026-10-03', locale: 'en' };
  [doc] = await knex('doctors').insert({ business_id: B, full_name: 'Dr Math', is_active: true, base_salary: 0 });
  await knex('commission_rules').insert({ business_id: B, doctor_id: doc, basis: 'percentage', rate: 10, service_overrides: '[]' });
});
test.after(() => knex.destroy());

test('money at the currency precision: checkout discount, compact amounts, commission and net', () => {
  assert.deepEqual(rules.checkoutAmounts(10, 15, 'JOD'), { amount: 10, discountPercent: 15, discountAmount: 1.765, originalAmount: 11.765 });
  assert.equal(fmt.formatCompact(1234.567, 'JOD', 'en'), '1,234.567 JOD');
  const c = rules.commission({ basis: 'percentage', rate: 10 }, [{ amount: 33.335 }]);
  assert.equal(c.totalCommission, 3.334);
  assert.equal(rules.payroll(0, c.totalCommission, []).netPayroll, 3.334);
});

test('doctor commission counts the clinic\'s own month (an invoice at 01:30 on the 1st in Amman is October)', async () => {
  await knex('invoices').insert([
    { business_id: ctx.businessId, doctor_id: doc, invoice_number: 900001, amount: 100, patient_name: 'A', created_at: new Date('2026-09-30T22:30:00Z') },
    { business_id: ctx.businessId, doctor_id: doc, invoice_number: 900002, amount: 200, patient_name: 'B', created_at: new Date('2026-09-30T20:30:00Z') },
  ]);
  const sep = await payroll.calculate(ctx, doc, '2026-09');
  const oct = await payroll.calculate(ctx, doc, '2026-10');
  assert.equal(sep.commission, 20);
  assert.equal(oct.commission, 10);
  const p = await pnl.monthNet(ctx, '2026-09');
  assert.equal(p.revenue, 200);
});

test('grouping by local day follows summer / winter time', async () => {
  const day = async (iso, tz) => (await knex.from(knex.raw('(select ? as t) x', [new Date(iso)])).first(knex.raw(`${lib.localDateSql('x.t', tz).toString()} as d`))).d;
  assert.equal(String(await day('2026-01-31T23:30:00Z', 'Europe/London')).slice(0, 10), '2026-01-31');
  assert.equal(String(await day('2026-07-31T23:30:00Z', 'Europe/London')).slice(0, 10), '2026-08-01');
  assert.equal(String(await day('2026-09-30T22:30:00Z', 'Asia/Amman')).slice(0, 10), '2026-10-01');
});

test('partner shares add up to the profit; P&L export change keeps its sign', () => {
  const shares = m.allocate(1, [{ id: 1, equity_percent: 33.33 }, { id: 2, equity_percent: 33.33 }, { id: 3, equity_percent: 33.34 }]);
  assert.equal(Math.round(shares.reduce((t, s) => t + s.amount, 0) * 1000) / 1000, 1);
  assert.equal(m.delta(500, -1000), 150);
});

test('subscription periods are never short; bank amounts rounded once', () => {
  assert.equal(subs.periodEnd('2024-02-29', 'yearly'), '2025-02-28');
  assert.equal(subs.periodEnd('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(subs.periodEnd('2026-01-28', 'monthly'), '2026-02-27');
  assert.equal(subs.periodEnd('2026-03-15', 'monthly'), '2026-04-14');
  assert.equal(bank.roundTo(1.005, 2), 1.01);
  assert.equal(bank.roundTo(100.125, 2), 100.13);
});

test('recurring: nothing is recorded after the end date', async () => {
  const id = await recurring.save(ctx, null, { title: 'Lease', category: 'rent', amount: '100', payment_method: 'cash', every: 'month', next_date: '2026-11-01', end_date: '2026-10-15', mode: 'auto' });
  assert.equal((await recurring.get(ctx, id)).is_active, 0);
  await knex('recurring_expenses').where({ id }).update({ is_active: true, next_date: '2026-09-01' });
  await recurring.runDue();
  const rows = await knex('expenses').where({ business_id: ctx.businessId, title: 'Lease' });
  assert.equal(rows.length, 2); // 1 Sep and 1 Oct (on or before the 15 Oct end); 1 Nov is past it
  const after = await recurring.get(ctx, id);
  assert.equal(after.is_active, 0);
  assert.equal(String(after.next_date), '2026-11-01');
});

test('dates: a timestamp is shown on the clinic\'s day; a calendar date as is', () => {
  const o = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  assert.match(fmt.formatDate(new Date('2026-10-02T22:30:00Z'), 'en', o, 'Asia/Amman'), /3 Oct.*01:30/);
  assert.equal(fmt.formatDate('2026-10-03', 'en', undefined, 'America/New_York'), '3 Oct 2026');
});

test('P&L memo: supplies received count every delivery in its own month, partial ones included', async () => {
  const [po] = await knex('purchase_orders').insert({ business_id: ctx.businessId, status: 'cancelled', supplier_name: 'Med Supply' });
  const [line] = await knex('purchase_order_items').insert({ purchase_order_id: po, name: 'Gloves', quantity: 8, received_quantity: 5, unit_cost: 0.125 });
  await knex('purchase_receipts').insert([
    { business_id: ctx.businessId, purchase_order_id: po, line_id: line, quantity: 3, unit_cost: 0.125, received_at: new Date('2026-08-25T10:00:00Z') },
    { business_id: ctx.businessId, purchase_order_id: po, line_id: line, quantity: 2, unit_cost: 0.125, received_at: new Date('2026-09-02T10:00:00Z') },
  ]);
  assert.equal((await pnl.monthNet(ctx, '2026-08')).suppliesReceived, 0.375);
  assert.equal((await pnl.monthNet(ctx, '2026-09')).suppliesReceived, 0.25);
});
