// Payroll — DocBook semantics:
//   monthly salary = base + bonus − deductions (advances are part of deductions)
//   commissions   = commission_earned on the rep's orders (percentage of order total or fixed per order,
//                   with per-region rates that override the default)
//   a month's salary counts as an expense only once that month is marked paid (employees.paid_months).
// Marking a month paid also stores a payroll_payments snapshot so payslips keep the figures of that month.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { repo } = require('../../core/crud');
const { z, validate, money, isoDate, monthKey, optionalString } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const engine = require('../finance/engine');
const fin = require('../finance/finance.data');

const STATUSES = ['active', 'on_leave', 'inactive'];
const COMMISSION_TYPES = ['percentage', 'fixed_per_order'];

const employees = repo({
  table: 'employees', entity: 'employee', searchable: ['name', 'role', 'phone', 'email'], filters: { status: 'status' },
  sortable: { name: 'name', salary: 'base_salary', hired: 'hire_date' }, defaultSort: ['name', 'asc'],
});

const parseRegions = (input) => {
  // Form sends region_names[] and region_rates[]; empty rows are ignored.
  const names = [].concat(input.region_names || []);
  const rates = [].concat(input.region_rates || []);
  const out = {};
  names.forEach((n, i) => { const name = String(n || '').trim(); const r = rates[i]; if (name && r !== '' && r !== undefined && Number.isFinite(Number(r)) && Number(r) >= 0) out[name.slice(0, 100)] = Number(r); });
  return out;
};

const schema = z.object({
  name: z.string().trim().min(1, 'Required.').max(160),
  role: optionalString(100),
  phone: optionalString(40),
  email: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().email('Enter a valid email address.').max(190).optional()),
  base_salary: money(),
  commission_type: z.enum(COMMISSION_TYPES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  commission_rate: money(),
  bonus: money(),
  deductions: money(),
  hire_date: z.preprocess((v) => (v === '' ? undefined : v), isoDate().optional()),
  status: z.enum(STATUSES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  bank_account: optionalString(100),
  notes: optionalString(5000),
});

async function save(ctx, id, input) {
  const d = validate(schema, input);
  if (d.commission_type === 'percentage' && d.commission_rate > 100) throw E.validation({ commission_rate: 'Must be between 0 and 100.' });
  const row = { ...d, role: d.role || null, phone: d.phone || null, email: d.email || null, hire_date: d.hire_date || null, bank_account: d.bank_account || null, notes: d.notes || null,
    region_commission_rates: JSON.stringify(parseRegions(input)) };
  if (id) { await employees.update(ctx, id, row); return id; }
  return employees.create(ctx, { ...row, paid_months: JSON.stringify([]) });
}

/** Payroll sheet for one month: every non-inactive employee with salary, commission and paid status. */
async function sheet(ctx, month) {
  const d = await fin.load(ctx.businessId);
  const commissionByEmp = {};
  const ordersByEmp = {};
  for (const o of d.orders) {
    if (!o.employeeId || engine.toMonthKey(o.date) !== month) continue; // eslint-disable-line no-continue
    commissionByEmp[o.employeeId] = (commissionByEmp[o.employeeId] || 0) + o.commissionEarned;
    ordersByEmp[o.employeeId] = (ordersByEmp[o.employeeId] || 0) + 1;
  }
  const payments = await knex('payroll_payments').where({ business_id: ctx.businessId, month });
  const payBy = Object.fromEntries(payments.map((p) => [p.employee_id, p]));
  const rows = d.employees.filter((e) => e.status !== 'inactive' || e.paidMonths.includes(month)).map((e) => {
    const salary = engine.monthlySalary(e);
    const commission = commissionByEmp[e.id] || 0;
    return { ...e, salary, commission, orders: ordersByEmp[e.id] || 0, net: salary + commission, paid: e.paidMonths.includes(month), payment: payBy[e.id] || null };
  });
  const totals = rows.reduce((t, r) => ({
    base: t.base + r.baseSalary, bonus: t.bonus + r.bonus, deductions: t.deductions + r.deductions, commission: t.commission + r.commission,
    net: t.net + r.net, paid: t.paid + (r.paid ? r.salary : 0), unpaid: t.unpaid + (r.paid ? 0 : r.salary),
  }), { base: 0, bonus: 0, deductions: 0, commission: 0, net: 0, paid: 0, unpaid: 0 });
  return { rows, totals, metrics: engine.computeMetrics(d, month) };
}

async function markPaid(ctx, employeeId, month, { method, reference } = {}, trx = null) {
  validate(z.object({ month: monthKey() }), { month });
  const run = async (t) => {
    const e = await t('employees').where({ id: employeeId, business_id: ctx.businessId }).forUpdate().first();
    if (!e) throw E.notFound('Employee');
    const paid = Array.isArray(e.paid_months) ? e.paid_months : JSON.parse(e.paid_months || '[]');
    if (paid.includes(month)) throw new AppError('MONTH_ALREADY_PAID', 'This month is already marked as paid.', 409);
    const d = await fin.load(ctx.businessId);
    const commission = d.orders.filter((o) => String(o.employeeId) === String(e.id) && engine.toMonthKey(o.date) === month).reduce((s, o) => s + o.commissionEarned, 0);
    const salary = Number(e.base_salary) + Number(e.bonus) - Number(e.deductions);
    await t('employees').where({ id: e.id }).update({ paid_months: JSON.stringify([...paid, month].sort()), updated_at: new Date() });
    await t('payroll_payments').insert({
      business_id: ctx.businessId, employee_id: e.id, month, base_salary: e.base_salary, bonus: e.bonus, deductions: e.deductions, commission,
      net_pay: salary + commission, payment_method: method || null, reference: reference || null, paid_by: ctx.userId,
    }).onConflict(['employee_id', 'month']).merge();
    await audit.record(ctx, 'payroll.month_paid', { entityType: 'employee', entityId: e.id, newValues: { month, net_pay: salary + commission } }, t);
  };
  return trx ? run(trx) : knex.transaction(run);
}

async function markAllPaid(ctx, month, opts) {
  const { rows } = await sheet(ctx, month);
  const todo = rows.filter((r) => !r.paid && r.status !== 'inactive');
  await knex.transaction(async (trx) => { for (const r of todo) await markPaid(ctx, r.id, month, opts, trx); }); // eslint-disable-line no-await-in-loop
  return todo.length;
}

async function unmarkPaid(ctx, employeeId, month) {
  return knex.transaction(async (trx) => {
    const e = await trx('employees').where({ id: employeeId, business_id: ctx.businessId }).forUpdate().first();
    if (!e) throw E.notFound('Employee');
    const paid = (Array.isArray(e.paid_months) ? e.paid_months : JSON.parse(e.paid_months || '[]')).filter((m) => m !== month);
    await trx('employees').where({ id: e.id }).update({ paid_months: JSON.stringify(paid), updated_at: new Date() });
    await trx('payroll_payments').where({ employee_id: e.id, month }).del();
    await audit.record(ctx, 'payroll.month_unpaid', { entityType: 'employee', entityId: e.id, oldValues: { month } }, trx);
  });
}

const payments = (ctx, employeeId) => knex('payroll_payments as p').leftJoin('users as u', 'u.id', 'p.paid_by')
  .where({ 'p.business_id': ctx.businessId, 'p.employee_id': employeeId }).orderBy('p.month', 'desc').select('p.*', 'u.name as paid_by_name');

/** Regions used by customers (suggested for per-region commission rates). */
async function regions(ctx) {
  const rows = await knex('customers').where({ business_id: ctx.businessId }).whereNotNull('region').whereNot('region', '').distinct('region').orderBy('region');
  return rows.map((r) => r.region);
}

module.exports = { employees, save, sheet, markPaid, markAllPaid, unmarkPaid, payments, regions, STATUSES, COMMISSION_TYPES };
