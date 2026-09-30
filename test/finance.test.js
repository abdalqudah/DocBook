// Finance: staff salaries (net pay, lock after paid, reopen), partners (equity ≤ 100 %, profit share, balances,
// idempotent distribution), budgets (usage, threshold, one notification per budget per month) and the profit & loss
// totals (no double counting of purchase orders; salaries and expenses counted once). Uses the docbook_test database.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const m = require('../src/modules/finance/math');
const staff = require('../src/modules/finance/staff.service');
const partners = require('../src/modules/finance/partners.service');
const budgets = require('../src/modules/finance/budgets.service');
const pnl = require('../src/modules/finance/pnl.service');
const { normalise, SYSTEM_ROLES } = require('../src/modules/rbac/permissions');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx;

test.before(async () => {
  await knex.migrate.latest();
  const email = `fin-${tag}@test.local`;
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Finance clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  ctx = { businessId, userId, userName: 'Owner', permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, today: '2026-09-15', locale: 'en' };
});
test.after(() => knex.destroy());

// ---------------------------------------------------------------- pure rules
test('net pay = base + allowances + bonuses − deductions − advances', () => {
  assert.equal(m.netPay({ base: 450, allowances: 50, deductions: 33.75 }), 466.25);
  const f = m.lineFigures({ base_salary: 300, allowances: 20, deductions: 10 }, [
    { type: 'bonus', amount: 25 }, { type: 'deduction', amount: 5 }, { type: 'advance', amount: 50 }, { type: 'bonus', amount: 0.5 }]);
  assert.deepEqual(f, { base: 300, allowances: 20, deductions: 10, bonuses: 25.5, extraDeductions: 5, advances: 50, net: 280.5 });
});

test('equity: state, and the total after an edit', () => {
  const ps = [{ id: 1, equity_percent: 60, status: 'active' }, { id: 2, equity_percent: 30, status: 'active' }, { id: 3, equity_percent: 50, status: 'inactive' }];
  assert.deepEqual(m.equityState(ps), { total: 90, state: 'under' });
  assert.equal(m.equityAfter(ps, null, 10), 100);
  assert.equal(m.equityAfter(ps, 2, 45), 105);
  assert.equal(m.equityAfter(ps, null, 20, 'inactive'), 90);
  assert.equal(m.equityState([{ equity_percent: 70 }, { equity_percent: 40 }]).state, 'over');
});

test('profit share and partner balance', () => {
  assert.equal(m.profitShare(1265.75, 60), 759.45);
  assert.equal(m.profitShare(-100, 40), -40); // losses are shared too
  const b = m.partnerBalance({ initial_investment: 30000 }, [
    { type: 'injection', amount: 5000 }, { type: 'withdrawal', amount: 1000 }, { type: 'profit_share', amount: 759.45 }, { type: 'profit_share', amount: -40 }]);
  assert.deepEqual(b, { investment: 30000, injections: 5000, withdrawals: 1000, profits: 719.45, balance: 34719.45 });
});

test('budget status: ok / warn at threshold / over', () => {
  assert.equal(m.budgetStatus(600, 400, 80).state, 'ok');
  const w = m.budgetStatus(600, 480, 80);
  assert.equal(w.state, 'warn'); assert.equal(w.usage, 80); assert.equal(w.remaining, 120);
  const o = m.budgetStatus(600, 650, 80);
  assert.equal(o.state, 'over'); assert.equal(o.remaining, 0);
});

test('statement totals: purchase orders are a memo only; margin', () => {
  const s = m.statement({ revenue: 1000, discounts: 50, expenses: [{ category: 'rent', amount: 300 }, { category: 'medical_supplies', amount: 120 }], doctorPayroll: 200, staffSalaries: 100, suppliesReceived: 120 });
  assert.equal(s.gross, 1050); assert.equal(s.opex, 420); assert.equal(s.costs, 720); assert.equal(s.net, 280); assert.equal(s.margin, 28);
  assert.equal(s.suppliesReceived, 120);
});

test('periods: quarter and previous period', () => {
  const q = m.resolvePeriod('quarter', '2026-Q1', '2026-09-30');
  assert.deepEqual(q.months, ['2026-01', '2026-02', '2026-03']);
  assert.equal(q.prevKey, '2025-Q4');
  assert.equal(m.resolvePeriod('month', 'bad', '2026-09-30').key, '2026-09');
});

test('finance.manage belongs to the owner only', () => {
  const role = (k) => normalise(SYSTEM_ROLES.find((r) => r.key === k).permissions);
  assert.ok(role('owner').includes('finance.manage'));
  for (const k of ['clinic_manager', 'accountant', 'doctor', 'nurse', 'receptionist']) assert.ok(!role(k).includes('finance.manage'), k);
});

// ---------------------------------------------------------------- database
test('staff run: prepare, adjust, pay, locked, reopen with a reason', async () => {
  const empId = await staff.saveEmployee(ctx, null, { name: 'Layla Haddad', job_title: 'Receptionist', base_salary: '450', allowances: '50', deductions: '33.75', status: 'active' });
  await staff.saveEmployee(ctx, null, { name: 'Future hire', base_salary: '400', status: 'active', hire_date: '2026-12-01' });
  assert.equal(await staff.prepare(ctx, '2026-08'), 1); // the future hire is not in August
  assert.equal(await staff.prepare(ctx, '2026-08'), 0); // idempotent
  const line = await knex('staff_payroll_lines').where({ employee_id: empId, period: '2026-08' }).first();
  await staff.addAdjustment(ctx, line.id, { type: 'bonus', amount: '25', reason: 'Extra shifts' });
  await staff.addAdjustment(ctx, line.id, { type: 'advance', amount: '50', reason: 'Mid-month advance' });
  await assert.rejects(staff.addAdjustment(ctx, line.id, { type: 'bonus', amount: '5', reason: '' }), (e) => e.code === 'VALIDATION_FAILED');
  const paid = await staff.markPaid(ctx, line.id, { paid_on: '2026-08-31', payment_method: 'bank_transfer', reference: 'TRF-1' });
  assert.equal(Number(paid.net_pay), 441.25);
  await assert.rejects(staff.addAdjustment(ctx, line.id, { type: 'bonus', amount: '5', reason: 'late' }), (e) => e.code === 'LINE_PAID');
  await assert.rejects(staff.markPaid(ctx, line.id, { paid_on: '2026-08-31', payment_method: 'cash' }), (e) => e.code === 'LINE_PAID');
  // Changing the employee's salary leaves the paid month untouched.
  await staff.saveEmployee(ctx, empId, { name: 'Layla Haddad', base_salary: '500', allowances: '50', deductions: '33.75', status: 'active' });
  assert.equal(Number((await knex('staff_payroll_lines').where({ id: line.id }).first()).net_pay), 441.25);
  // Salary cost for the P&L = net paid + advance taken back.
  assert.deepEqual(await staff.paidByMonth(ctx.businessId, '2026-08', '2026-08'), { '2026-08': 491.25 });
  await assert.rejects(staff.reopen(ctx, line.id, ''), (e) => e.code === 'VALIDATION_FAILED');
  await staff.reopen(ctx, line.id, 'Wrong allowance');
  const after = await knex('staff_payroll_lines').where({ id: line.id }).first();
  assert.equal(after.status, 'draft'); assert.equal(after.reopen_reason, 'Wrong allowance');
  assert.equal(Number(after.net_pay), 441.25); // reopening keeps the month's own figures
  const log = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'staff.salary_reopened' }).first();
  assert.ok(log);
  await staff.markPaid(ctx, line.id, { paid_on: '2026-09-01', payment_method: 'cash' });
  await assert.rejects(staff.removeEmployee(ctx, empId), (e) => e.code === 'EMPLOYEE_HAS_PAID');
});

test('partners: equity cannot exceed 100 %, distribution is idempotent, balances', async () => {
  const a = await partners.save(ctx, null, { name: 'Khaled', initial_investment: '30000', equity_percent: '60', status: 'active' });
  await assert.rejects(partners.distribute(ctx, '2026-07'), (e) => e.code === 'EQUITY_NOT_100');
  await assert.rejects(partners.save(ctx, null, { name: 'Too much', initial_investment: '1', equity_percent: '50', status: 'active' }), (e) => e.code === 'EQUITY_OVER_100');
  await partners.save(ctx, null, { name: 'Rana', initial_investment: '20000', equity_percent: '40', status: 'active' });
  await partners.addTransaction(ctx, a, { type: 'withdrawal', amount: '500', date: '2026-07-10' });
  await partners.addTransaction(ctx, a, { type: 'injection', amount: '1000', date: '2026-07-11' });
  await knex('expenses').insert({ business_id: ctx.businessId, date: '2026-07-05', category: 'rent', title: 'Rent', amount: 400, payment_method: 'cash' });
  await knex('invoices').insert({ business_id: ctx.businessId, invoice_number: 9001, patient_name: 'P', amount: 1400, created_at: new Date('2026-07-10T09:00:00Z') });
  await assert.rejects(partners.distribute(ctx, '2026-09'), (e) => e.code === 'MONTH_NOT_CLOSED');
  const r = await partners.distribute(ctx, '2026-07');
  assert.equal(r.net, 1000);
  assert.deepEqual(r.allocations.map((x) => x.amount).sort(), [400, 600]);
  await assert.rejects(partners.distribute(ctx, '2026-07'), (e) => e.code === 'ALREADY_DISTRIBUTED');
  const ov = await partners.overview(ctx);
  const k = ov.partners.find((p) => p.id === a);
  assert.equal(k.balance, 30000 + 1000 + 600 - 500);
  assert.equal(ov.equity.state, 'ok');
  const share = await knex('partner_transactions').where({ partner_id: a, type: 'profit_share' }).first();
  await assert.rejects(partners.removeTransaction(ctx, share.id), (e) => e.code === 'SHARE_IN_DISTRIBUTION');
  await partners.cancelDistribution(ctx, r.id);
  assert.equal((await partners.overview(ctx)).partners.find((p) => p.id === a).profits, 0);
});

test('budgets: usage, threshold and one notification per budget per month', async () => {
  const month = '2026-05';
  const id = await budgets.save(ctx, null, { scope_key: 'cat:utilities', monthly_limit: '100', threshold_percent: '80', is_active: '1' });
  await assert.rejects(budgets.save(ctx, null, { scope_key: 'cat:utilities', monthly_limit: '50', is_active: '1' }), (e) => e.code === 'BUDGET_EXISTS');
  await knex('expenses').insert({ business_id: ctx.businessId, date: `${month}-03`, category: 'utilities', title: 'Power', amount: 70, payment_method: 'cash' });
  assert.equal(await budgets.check(ctx.businessId, ctx.timezone, month), 0);
  await knex('expenses').insert({ business_id: ctx.businessId, date: `${month}-10`, category: 'utilities', title: 'Water', amount: 15, payment_method: 'cash' });
  const [ev] = (await budgets.evaluate(ctx.businessId, ctx.timezone, month)).filter((b) => b.id === id);
  assert.equal(ev.status.state, 'warn'); assert.equal(ev.status.usage, 85);
  assert.equal(await budgets.check(ctx.businessId, ctx.timezone, month), 1);
  assert.equal(await budgets.check(ctx.businessId, ctx.timezone, month), 0); // once per month
  await knex('expenses').insert({ business_id: ctx.businessId, date: `${month}-20`, category: 'utilities', title: 'Internet', amount: 30, payment_method: 'cash' });
  assert.equal(await budgets.check(ctx.businessId, ctx.timezone, month), 1); // exceeded: one more
  assert.equal(await budgets.check(ctx.businessId, ctx.timezone, month), 0);
  const n = await knex('notifications').where({ business_id: ctx.businessId }).where('dedupe_key', 'like', `budget:${id}:${month}:%`).select('dedupe_key', 'permission');
  assert.deepEqual(n.map((x) => x.dedupe_key).sort(), [`budget:${id}:${month}:over`, `budget:${id}:${month}:warn`]);
  assert.ok(n.every((x) => x.permission === 'finance.view'));
});

test('P&L: revenue, expenses, doctor + staff salaries; received purchase orders are not added', async () => {
  const month = '2026-04';
  const b = ctx.businessId;
  await knex('invoices').insert([
    { business_id: b, invoice_number: 9101, patient_name: 'A', amount: 900, discount_amount: 100, created_at: new Date('2026-04-05T08:00:00Z') },
    { business_id: b, invoice_number: 9102, patient_name: 'B', amount: 300, created_at: new Date('2026-04-20T08:00:00Z') },
    { business_id: b, invoice_number: 9103, patient_name: 'C', amount: 999, created_at: new Date('2026-05-02T08:00:00Z') }, // next month
  ]);
  await knex('expenses').insert([
    { business_id: b, date: '2026-04-02', category: 'rent', title: 'Rent', amount: 400, payment_method: 'cash' },
    { business_id: b, date: '2026-04-12', category: 'medical_supplies', title: 'Supplier bill', amount: 150, payment_method: 'cash' },
  ]);
  const [docId] = await knex('doctors').insert({ business_id: b, full_name: 'Dr Test', slot_duration_minutes: 30 });
  await knex('payroll_payments').insert({ business_id: b, doctor_id: docId, period: month, base_salary: 500, net_pay: 450, advances: 50 });
  const empId = await staff.saveEmployee(ctx, null, { name: 'Nurse', base_salary: '200', status: 'active' });
  await staff.prepare(ctx, month);
  const line = await knex('staff_payroll_lines').where({ employee_id: empId, period: month }).first();
  await staff.markPaid(ctx, line.id, { paid_on: '2026-04-30', payment_method: 'cash' });
  // The same supplies received on a purchase order (their bill is the expense above).
  const [poId] = await knex('purchase_orders').insert({ business_id: b, supplier_name: 'Supplier', status: 'received', received_at: new Date('2026-04-12T10:00:00Z') });
  await knex('purchase_order_items').insert({ purchase_order_id: poId, name: 'Gloves', quantity: 10, received_quantity: 10, unit_cost: 15 });

  const s = await pnl.monthNet(ctx, month);
  assert.equal(s.revenue, 1200); assert.equal(s.discounts, 100); assert.equal(s.gross, 1300);
  assert.equal(s.opex, 550);
  assert.equal(s.doctorPayroll, 500); // net 450 + advance 50
  const staffApr = (await staff.paidByMonth(b, month, month))[month];
  assert.equal(s.staffSalaries, staffApr);
  assert.equal(s.suppliesReceived, 150); // memo only
  assert.equal(s.costs, 550 + 500 + staffApr); // purchase order not added on top of the supplier bill
  assert.equal(s.net, 1200 - s.costs);
  const built = await pnl.build(ctx, m.resolvePeriod('month', month, ctx.today));
  assert.equal(built.trend.length, 12);
  assert.equal(built.cur.net, s.net);
});
