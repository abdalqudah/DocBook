// Doctor commissions and payroll — DocBook's commissions.ts + payroll.ts, with the maths in money-rules.js.
// Adjustments (bonus / deduction / advance) go through an approval step; only approved ones count.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, money, monthKey, optionalString } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const rules = require('./money-rules');

const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; } };

async function rule(ctx, doctorId) {
  const r = await knex('commission_rules').where({ business_id: ctx.businessId, doctor_id: doctorId }).first();
  return r ? { basis: r.basis, rate: Number(r.rate), serviceOverrides: parse(r.service_overrides, []) } : null;
}

async function saveRule(ctx, doctorId, input) {
  const doc = await knex('doctors').where({ id: doctorId, business_id: ctx.businessId }).first('id');
  if (!doc) throw E.notFound('Doctor');
  const d = validate(z.object({ basis: z.enum(rules.BASES, { errorMap: () => ({ message: 'Choose a valid value.' }) }), rate: money() }), input);
  if (d.basis === 'percentage' && d.rate > 100) throw E.validation({ rate: 'Must be between 0 and 100.' });
  const names = [].concat(input.ov_service || []); const bases = [].concat(input.ov_basis || []); const rates = [].concat(input.ov_rate || []);
  const overrides = names.map((s, i) => ({ serviceName: String(s || '').trim(), basis: bases[i], rate: Number(rates[i]) }))
    .filter((o) => o.serviceName && ['percentage', 'fixed_per_visit'].includes(o.basis) && Number.isFinite(o.rate) && o.rate >= 0 && (o.basis !== 'percentage' || o.rate <= 100));
  const before = await rule(ctx, doctorId);
  await knex('commission_rules').insert({ business_id: ctx.businessId, doctor_id: doctorId, basis: d.basis, rate: d.rate, service_overrides: JSON.stringify(overrides) })
    .onConflict(['business_id', 'doctor_id']).merge({ basis: d.basis, rate: d.rate, service_overrides: JSON.stringify(overrides), updated_at: new Date() });
  await audit.record(ctx, 'commission.rule_saved', { entityType: 'doctor', entityId: doctorId, oldValues: before, newValues: { ...d, overrides: overrides.length } });
}

// The month is the clinic's own calendar month (as in the profit & loss), not the UTC one: an invoice issued at 01:30
// on the 1st in Amman belongs to that month.
async function invoicesFor(ctx, doctorId, from, to) {
  const tz = ctx.timezone || (await knex('businesses').where({ id: ctx.businessId }).first('timezone') || {}).timezone || 'Asia/Amman';
  return require('./records.lib').whereLocalDates(knex('invoices').where({ business_id: ctx.businessId, doctor_id: doctorId }), 'created_at', from, to, tz) // eslint-disable-line global-require
    .orderBy('created_at').select('id', 'invoice_number', 'created_at', 'service_name', 'patient_id as patientId', 'patient_name', 'amount')
    .then((rows) => rows.map((r) => ({ ...r, serviceName: r.service_name, amount: Number(r.amount) })));
}

async function commission(ctx, doctorId, from, to) {
  return rules.commission(await rule(ctx, doctorId), await invoicesFor(ctx, doctorId, from, to));
}

const adjustments = (ctx, doctorId, period) => knex('payroll_adjustments as a').leftJoin('users as u', 'u.id', 'a.created_by').leftJoin('users as v', 'v.id', 'a.approved_by')
  .where({ 'a.business_id': ctx.businessId, 'a.doctor_id': doctorId, 'a.period': period }).orderBy('a.created_at', 'desc')
  .select('a.*', 'u.name as created_by_name', 'v.name as approved_by_name').then((rows) => rows.map((r) => ({ ...r, approvalStatus: r.approval_status, amount: Number(r.amount) })));

async function addAdjustment(ctx, doctorId, input) {
  const doc = await knex('doctors').where({ id: doctorId, business_id: ctx.businessId }).first('id');
  if (!doc) throw E.notFound('Doctor');
  const d = validate(z.object({ type: z.enum(['bonus', 'deduction', 'advance'], { errorMap: () => ({ message: 'Choose a valid value.' }) }), amount: money().refine((v) => v > 0, 'Must be zero or more.'), reason: optionalString(500), period: monthKey() }), input);
  const paid = await knex('payroll_payments').where({ doctor_id: doctorId, period: d.period }).first('id');
  if (paid) throw new AppError('PERIOD_PAID', 'This month is already paid. Undo the payment first.', 409);
  const [aid] = await knex('payroll_adjustments').insert({ business_id: ctx.businessId, doctor_id: doctorId, type: d.type, amount: d.amount, reason: d.reason || '', period: d.period, created_by: ctx.userId });
  await audit.record(ctx, 'payroll.adjustment_created', { entityType: 'doctor', entityId: doctorId, newValues: d });
  return aid;
}

async function reviewAdjustment(ctx, adjId, decision) {
  if (!['approved', 'rejected'].includes(decision)) throw E.validation({ decision: 'Choose a valid value.' });
  const a = await knex('payroll_adjustments').where({ id: adjId, business_id: ctx.businessId }).first();
  if (!a) throw E.notFound('Adjustment');
  if (a.created_by === ctx.userId && decision === 'approved' && !ctx.permissions.has('data.manage')) throw new AppError('FOUR_EYES', 'Someone else must approve an adjustment you created.', 409);
  const paid = await knex('payroll_payments').where({ doctor_id: a.doctor_id, period: a.period }).first('id');
  if (paid) throw new AppError('PERIOD_PAID', 'This month is already paid. Undo the payment first.', 409);
  await knex('payroll_adjustments').where({ id: a.id }).update({ approval_status: decision, approved_by: ctx.userId });
  await audit.record(ctx, `payroll.adjustment_${decision}`, { entityType: 'doctor', entityId: a.doctor_id, newValues: { id: a.id, type: a.type, amount: Number(a.amount) } });
}

async function calculate(ctx, doctorId, period) {
  const range = rules.periodRange(period);
  if (!range) throw E.validation({ period: 'Enter a valid month.' });
  const doc = await knex('doctors').where({ id: doctorId, business_id: ctx.businessId }).first('id', 'full_name', 'base_salary');
  if (!doc) throw E.notFound('Doctor');
  const comm = await commission(ctx, doctorId, range.from, range.to);
  const adj = await adjustments(ctx, doctorId, period);
  const pay = rules.payroll(doc.base_salary, comm.totalCommission, adj);
  const payment = await knex('payroll_payments as p').leftJoin('users as u', 'u.id', 'p.paid_by').where({ 'p.business_id': ctx.businessId, 'p.doctor_id': doctorId, 'p.period': period }).first('p.*', 'u.name as paid_by_name');
  return { doctor: doc, period, range, commissionDetail: comm, adjustments: adj, ...pay, payment: payment || null, hasRule: comm.hasRule };
}

/** Whole-clinic payroll sheet for a month. */
async function sheet(ctx, period) {
  const docs = await knex('doctors').where({ business_id: ctx.businessId }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }]).select('id');
  const rows = [];
  for (const d of docs) rows.push(await calculate(ctx, d.id, period)); // eslint-disable-line no-await-in-loop
  const totals = rows.reduce((t, r) => ({ base: t.base + r.baseSalary, commission: t.commission + r.commission, bonuses: t.bonuses + r.bonuses, deductions: t.deductions + r.deductions + r.advances, net: t.net + r.netPayroll, revenue: t.revenue + r.commissionDetail.totalRevenue }),
    { base: 0, commission: 0, bonuses: 0, deductions: 0, net: 0, revenue: 0 });
  return { rows, totals };
}

/** Marks a doctor's month as paid, storing the figures of that moment for the payslip. */
async function markPaid(ctx, doctorId, period, { method, reference } = {}) {
  const c = await calculate(ctx, doctorId, period);
  if (c.payment) throw new AppError('MONTH_ALREADY_PAID', 'This month is already marked as paid.', 409);
  if (c.adjustments.some((a) => a.approvalStatus === 'pending')) throw new AppError('PENDING_ADJUSTMENTS', 'Approve or reject the pending adjustments first.', 409);
  await knex('payroll_payments').insert({ business_id: ctx.businessId, doctor_id: doctorId, period, base_salary: c.baseSalary, commission: c.commission, bonuses: c.bonuses, deductions: c.deductions, advances: c.advances, net_pay: c.netPayroll, payment_method: method || null, reference: reference || null, paid_by: ctx.userId });
  await audit.record(ctx, 'payroll.paid', { entityType: 'doctor', entityId: doctorId, newValues: { period, net_pay: c.netPayroll } });
}

async function undoPaid(ctx, doctorId, period) {
  const n = await knex('payroll_payments').where({ business_id: ctx.businessId, doctor_id: doctorId, period }).del();
  if (!n) throw E.notFound('Payment');
  await audit.record(ctx, 'payroll.payment_undone', { entityType: 'doctor', entityId: doctorId, oldValues: { period } });
}

module.exports = { rule, saveRule, commission, adjustments, addAdjustment, reviewAdjustment, calculate, sheet, markPaid, undoPaid };
