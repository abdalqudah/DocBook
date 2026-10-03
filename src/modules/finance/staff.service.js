// Staff salaries for non-doctor staff (reception, nurses, accountant, cleaners…): employees, the monthly run
// (one line per employee per month, prefilled from the employee record), one-off adjustments with a reason,
// paid → locked (reopen with a reason, audited), payslip figures.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, money, isoDate, optionalString, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const m = require('./math');

const METHODS = ['bank_transfer', 'cash'];
const ADJ_TYPES = ['bonus', 'deduction', 'advance'];

const employeeSchema = z.object({
  name: z.string().trim().min(1, 'Required.').max(190),
  job_title: optionalString(120),
  phone: optionalString(40),
  email: z.preprocess(emptyToUndefined, z.string().trim().toLowerCase().email('Enter a valid email address.').max(190).optional()),
  bank_name: optionalString(120),
  iban: z.preprocess((v) => { const s = emptyToUndefined(v); return typeof s === 'string' ? s.replace(/\s+/g, '').toUpperCase() : s; }, z.string().max(60).optional()),
  base_salary: money(),
  allowances: money(),
  deductions: money(),
  hire_date: z.preprocess(emptyToUndefined, isoDate().optional()),
  status: z.enum(['active', 'inactive'], { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  membership_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  notes: optionalString(2000),
});

const locked = () => new AppError('LINE_PAID', 'This salary is already paid. Reopen it first.', 409);

async function listEmployees(ctx, { status } = {}) {
  const q = knex('staff_employees as e').leftJoin('memberships as ms', 'ms.id', 'e.membership_id').leftJoin('users as u', 'u.id', 'ms.user_id')
    .where('e.business_id', ctx.businessId).orderBy([{ column: 'e.status' }, { column: 'e.name' }]).select('e.*', 'u.name as user_name', 'u.email as user_email');
  if (status === 'active' || status === 'inactive') q.where('e.status', status);
  return q;
}

async function getEmployee(ctx, id) {
  const e = await knex('staff_employees').where({ id, business_id: ctx.businessId }).first();
  if (!e) throw E.notFound('Employee');
  return e;
}

/** Clinic members who can be linked (doctors are paid through the doctor payroll, so doctor logins are left out). */
async function memberOptions(ctx) {
  return knex('memberships as ms').join('users as u', 'u.id', 'ms.user_id').leftJoin('roles as r', 'r.id', 'ms.role_id')
    .where({ 'ms.business_id': ctx.businessId }).whereNull('ms.doctor_id').orderBy('u.name')
    .select('ms.id', 'u.name', 'u.email', 'ms.job_title', 'r.key as role_key', 'ms.status');
}

async function saveEmployee(ctx, id, input) {
  const d = validate(employeeSchema, input);
  if (d.membership_id) {
    const ms = await knex('memberships').where({ id: d.membership_id, business_id: ctx.businessId }).whereNull('doctor_id').first('id');
    if (!ms) throw E.validation({ membership_id: 'Choose a valid value.' });
    const taken = await knex('staff_employees').where({ business_id: ctx.businessId, membership_id: d.membership_id }).modify((q) => { if (id) q.whereNot('id', id); }).first('id');
    if (taken) throw new AppError('MEMBER_LINKED', 'This login is already linked to another employee.', 409);
  }
  const row = {
    name: d.name, job_title: d.job_title || null, phone: d.phone || null, email: d.email || null, bank_name: d.bank_name || null, iban: d.iban || null,
    base_salary: d.base_salary, allowances: d.allowances, deductions: d.deductions, hire_date: d.hire_date || null, status: d.status,
    membership_id: d.membership_id || null, notes: d.notes || null,
  };
  if (id) {
    const before = await getEmployee(ctx, id);
    await knex('staff_employees').where({ id: before.id }).update({ ...row, updated_at: new Date() });
    await refreshDrafts(ctx, before.id);
    await audit.record(ctx, 'staff.employee_updated', { entityType: 'staff_employee', entityId: id, oldValues: pickMoney(before), newValues: pickMoney(row) });
    return before.id;
  }
  const [newId] = await knex('staff_employees').insert({ ...row, business_id: ctx.businessId });
  await audit.record(ctx, 'staff.employee_created', { entityType: 'staff_employee', entityId: newId, newValues: pickMoney(row) });
  return newId;
}
const pickMoney = (r) => ({ name: r.name, job_title: r.job_title, base_salary: Number(r.base_salary), allowances: Number(r.allowances), deductions: Number(r.deductions), status: r.status });

async function removeEmployee(ctx, id) {
  const e = await getEmployee(ctx, id);
  const paid = await knex('staff_payroll_lines').where({ employee_id: e.id, status: 'paid' }).first('id');
  if (paid) throw new AppError('EMPLOYEE_HAS_PAID', 'This employee has paid salaries on record. Mark them inactive instead.', 409);
  await knex('staff_employees').where({ id: e.id }).del();
  await audit.record(ctx, 'staff.employee_deleted', { entityType: 'staff_employee', entityId: e.id, oldValues: pickMoney(e) });
}

/** Draft lines follow the employee record (name, title, fixed salary parts); paid lines keep their figures. */
async function refreshDrafts(ctx, employeeId) {
  const e = await knex('staff_employees').where({ id: employeeId, business_id: ctx.businessId }).first();
  if (!e) return;
  const lines = await knex('staff_payroll_lines').where({ employee_id: e.id, status: 'draft' }).select('id');
  for (const l of lines) {
    await knex('staff_payroll_lines').where({ id: l.id }).update({ employee_name: e.name, job_title: e.job_title, base_salary: e.base_salary, allowances: e.allowances, deductions: e.deductions, updated_at: new Date() }); // eslint-disable-line no-await-in-loop
    await recompute(l.id); // eslint-disable-line no-await-in-loop
  }
}

/** Stores the current totals of a draft line (bonuses, one-off deductions, advances, net). */
async function recompute(lineId, trx = knex) {
  const line = await trx('staff_payroll_lines').where({ id: lineId }).first();
  if (!line || line.status !== 'draft') return line;
  const adjs = await trx('staff_payroll_adjustments').where({ line_id: lineId });
  const f = m.lineFigures(line, adjs);
  await trx('staff_payroll_lines').where({ id: lineId }).update({ bonuses: f.bonuses, extra_deductions: f.extraDeductions, advances: f.advances, net_pay: f.net });
  return { ...line, bonuses: f.bonuses, extra_deductions: f.extraDeductions, advances: f.advances, net_pay: f.net };
}

/** Adds a line for every active employee that has none in this month; returns how many were added. */
async function prepare(ctx, period) {
  if (!m.isMonth(period)) throw E.validation({ period: 'Enter a valid month.' });
  const emps = await knex('staff_employees').where({ business_id: ctx.businessId, status: 'active' });
  const have = new Set((await knex('staff_payroll_lines').where({ business_id: ctx.businessId, period }).select('employee_id')).map((r) => r.employee_id));
  let added = 0;
  for (const e of emps) {
    if (have.has(e.id)) continue; // eslint-disable-line no-continue
    // A hire date after the month means the employee had not started yet.
    if (e.hire_date && String(e.hire_date).slice(0, 7) > period) continue; // eslint-disable-line no-continue
    const net = m.netPay({ base: e.base_salary, allowances: e.allowances, deductions: e.deductions });
    await knex('staff_payroll_lines').insert({ business_id: ctx.businessId, employee_id: e.id, period, employee_name: e.name, job_title: e.job_title, base_salary: e.base_salary, allowances: e.allowances, deductions: e.deductions, net_pay: net }) // eslint-disable-line no-await-in-loop
      .onConflict(['employee_id', 'period']).ignore();
    added += 1;
  }
  if (added) await audit.record(ctx, 'staff.payroll_prepared', { entityType: 'staff_payroll', entityId: period, newValues: { period, lines: added } });
  return added;
}

async function getLine(ctx, id) {
  const l = await knex('staff_payroll_lines as l').leftJoin('users as u', 'u.id', 'l.paid_by').leftJoin('users as r', 'r.id', 'l.reopened_by')
    .where({ 'l.id': id, 'l.business_id': ctx.businessId }).first('l.*', 'u.name as paid_by_name', 'r.name as reopened_by_name');
  if (!l) throw E.notFound('Salary');
  return l;
}

const adjustmentsOf = (lineIds) => (lineIds.length ? knex('staff_payroll_adjustments as a').leftJoin('users as u', 'u.id', 'a.created_by')
  .whereIn('a.line_id', lineIds).orderBy('a.id').select('a.*', 'u.name as created_by_name') : Promise.resolve([]));

/** The month's sheet: lines with their adjustments and figures, totals, and active employees not in the run yet. */
async function sheet(ctx, period) {
  const lines = await knex('staff_payroll_lines as l').join('staff_employees as e', 'e.id', 'l.employee_id')
    .where({ 'l.business_id': ctx.businessId, 'l.period': period }).orderBy('l.employee_name')
    .select('l.*', 'e.status as employee_status', 'e.bank_name', 'e.iban');
  const adjs = await adjustmentsOf(lines.map((l) => l.id));
  const rows = lines.map((l) => {
    const mine = adjs.filter((a) => a.line_id === l.id);
    const f = l.status === 'paid'
      ? { base: Number(l.base_salary), allowances: Number(l.allowances), deductions: Number(l.deductions), bonuses: Number(l.bonuses), extraDeductions: Number(l.extra_deductions), advances: Number(l.advances), net: Number(l.net_pay) }
      : m.lineFigures(l, mine);
    return { ...l, adjustments: mine, f };
  });
  const totals = rows.reduce((t, r) => ({
    base: m.round(t.base + r.f.base), allowances: m.round(t.allowances + r.f.allowances), bonuses: m.round(t.bonuses + r.f.bonuses),
    deductions: m.round(t.deductions + r.f.deductions + r.f.extraDeductions), fixedDeductions: m.round(t.fixedDeductions + r.f.deductions), extraDeductions: m.round(t.extraDeductions + r.f.extraDeductions), advances: m.round(t.advances + r.f.advances), net: m.round(t.net + r.f.net),
    paid: m.round(t.paid + (r.status === 'paid' ? r.f.net : 0)), paidCount: t.paidCount + (r.status === 'paid' ? 1 : 0),
  }), { base: 0, allowances: 0, bonuses: 0, deductions: 0, fixedDeductions: 0, extraDeductions: 0, advances: 0, net: 0, paid: 0, paidCount: 0 });
  const inRun = new Set(lines.map((l) => l.employee_id));
  const missing = (await knex('staff_employees').where({ business_id: ctx.businessId, status: 'active' }).orderBy('name').select('id', 'name', 'hire_date'))
    .filter((e) => !inRun.has(e.id) && !(e.hire_date && String(e.hire_date).slice(0, 7) > period));
  return { rows, totals, missing };
}

const adjSchema = z.object({
  type: z.enum(ADJ_TYPES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  amount: money().refine((v) => v > 0, 'Too small.'),
  reason: z.string().trim().min(1, 'Required.').max(500),
});

async function addAdjustment(ctx, lineId, input) {
  const line = await getLine(ctx, lineId);
  if (line.status === 'paid') throw locked();
  const d = validate(adjSchema, input);
  await knex('staff_payroll_adjustments').insert({ business_id: ctx.businessId, line_id: line.id, type: d.type, amount: d.amount, reason: d.reason, created_by: ctx.userId });
  const after = await recompute(line.id);
  await audit.record(ctx, 'staff.adjustment_added', { entityType: 'staff_payroll_line', entityId: line.id, newValues: { period: line.period, employee: line.employee_name, ...d, net_pay: Number(after.net_pay) } });
  return line;
}

async function removeAdjustment(ctx, adjId) {
  const a = await knex('staff_payroll_adjustments').where({ id: adjId, business_id: ctx.businessId }).first();
  if (!a) throw E.notFound('Adjustment');
  const line = await getLine(ctx, a.line_id);
  if (line.status === 'paid') throw locked();
  await knex('staff_payroll_adjustments').where({ id: a.id }).del();
  await recompute(line.id);
  await audit.record(ctx, 'staff.adjustment_removed', { entityType: 'staff_payroll_line', entityId: line.id, oldValues: { type: a.type, amount: Number(a.amount), reason: a.reason } });
  return line;
}

const paySchema = z.object({
  paid_on: isoDate(),
  payment_method: z.enum(METHODS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  reference: optionalString(100),
});

/** Marks a line paid: its figures are frozen and it is locked. */
async function markPaid(ctx, lineId, input) {
  const d = validate(paySchema, input);
  return knex.transaction(async (trx) => {
    const line = await trx('staff_payroll_lines').where({ id: lineId, business_id: ctx.businessId }).forUpdate().first();
    if (!line) throw E.notFound('Salary');
    if (line.status === 'paid') throw locked();
    const fresh = await recompute(line.id, trx);
    await trx('staff_payroll_lines').where({ id: line.id }).update({ status: 'paid', paid_on: d.paid_on, payment_method: d.payment_method, reference: d.reference || null, paid_by: ctx.userId, paid_at: new Date(), updated_at: new Date() });
    await audit.record(ctx, 'staff.salary_paid', { entityType: 'staff_payroll_line', entityId: line.id, newValues: { period: line.period, employee: line.employee_name, net_pay: Number(fresh.net_pay), method: d.payment_method, paid_on: d.paid_on } }, trx);
    return { ...fresh, status: 'paid' };
  });
}

/** Pays every draft line of the month with the same date/method; returns the number paid. */
async function payAll(ctx, period, input) {
  validate(paySchema, input);
  const drafts = await knex('staff_payroll_lines').where({ business_id: ctx.businessId, period, status: 'draft' }).select('id');
  for (const l of drafts) await markPaid(ctx, l.id, input); // eslint-disable-line no-await-in-loop
  return drafts.length;
}

async function reopen(ctx, lineId, reason) {
  const why = String(reason || '').trim().slice(0, 500);
  if (!why) throw E.validation({ reason: 'Required.' });
  const line = await getLine(ctx, lineId);
  if (line.status !== 'paid') throw new AppError('NOT_PAID', 'This salary is not marked as paid.', 409);
  await knex('staff_payroll_lines').where({ id: line.id }).update({ status: 'draft', paid_on: null, payment_method: null, reference: null, paid_by: null, paid_at: null, reopened_at: new Date(), reopened_by: ctx.userId, reopen_reason: why, updated_at: new Date() });
  await recompute(line.id);
  await audit.record(ctx, 'staff.salary_reopened', { entityType: 'staff_payroll_line', entityId: line.id, oldValues: { status: 'paid', net_pay: Number(line.net_pay), paid_on: line.paid_on }, newValues: { status: 'draft', reason: why } });
  return line;
}

async function removeLine(ctx, lineId) {
  const line = await getLine(ctx, lineId);
  if (line.status === 'paid') throw locked();
  await knex('staff_payroll_lines').where({ id: line.id }).del();
  await audit.record(ctx, 'staff.line_removed', { entityType: 'staff_payroll_line', entityId: line.id, oldValues: { period: line.period, employee: line.employee_name } });
  return line;
}

/** Payslip data: the line, its adjustments, its figures and the employee. */
async function payslip(ctx, lineId) {
  const line = await getLine(ctx, lineId);
  const [adjs, emp] = await Promise.all([adjustmentsOf([line.id]), knex('staff_employees').where({ id: line.employee_id }).first()]);
  const f = line.status === 'paid'
    ? { base: Number(line.base_salary), allowances: Number(line.allowances), deductions: Number(line.deductions), bonuses: Number(line.bonuses), extraDeductions: Number(line.extra_deductions), advances: Number(line.advances), net: Number(line.net_pay) }
    : m.lineFigures(line, adjs);
  return { line, adjustments: adjs, f, employee: emp };
}

/**
 * Salary cost of paid staff salaries per month (net paid + advances recovered in that month: the advance itself was
 * paid in cash earlier, so the month's salary cost is the pay before the advance is taken back).
 */
async function paidByMonth(businessId, fromMonth, toMonth) {
  const rows = await knex('staff_payroll_lines').where({ business_id: businessId, status: 'paid' }).whereBetween('period', [fromMonth, toMonth])
    .groupBy('period').select('period').sum({ net: 'net_pay' }).sum({ adv: 'advances' });
  return Object.fromEntries(rows.map((r) => [r.period, m.round(Number(r.net) + Number(r.adv))]));
}

module.exports = {
  METHODS, ADJ_TYPES, listEmployees, getEmployee, memberOptions, saveEmployee, removeEmployee, prepare, sheet, getLine, addAdjustment, removeAdjustment,
  markPaid, payAll, reopen, removeLine, payslip, paidByMonth, recompute,
};
