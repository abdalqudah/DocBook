// Profit & loss from the clinic's own records, per month.
//
// Basis (shown on the page): CASH BASIS.
//  • Revenue = invoices issued at payment time (cashier, front desk and verified online card payments all create an
//    invoice when the money is taken), by the clinic-local date of the invoice. The invoice amount is already net of
//    the discount; discounts are shown for information. A refunded online payment voids its invoice, so refunds
//    are already out of revenue — the refunded total is shown as a memo line only.
//  • Operating expenses = the expenses recorded in the period, by category.
//  • Doctor payroll = doctor salaries marked paid for the salary months in the period (net pay + advances
//    recovered — the advance was paid out earlier); staff salaries the same, from the staff salary run.
//  • Supplies received on purchase orders are NOT added: the supplier's bill is recorded as an expense (usually
//    "medical supplies"), so adding the order value too would count the same purchase twice. It is a memo line.
const knex = require('../../db/knex');
const lib = require('../clinic/records.lib');
const payParts = require('../clinic/payment-parts');
const staff = require('./staff.service');
const m = require('./math');

const num = (v) => Number(v) || 0;
const ym = (v) => (v instanceof Date ? v.toISOString().slice(0, 7) : String(v).slice(0, 7));

/**
 * Month-by-month figures for fromMonth..toMonth: { months: { 'YYYY-MM': { revenue, discounts, invoices, online,
 * refunds, byCat: { key: amount }, opex, doctorPayroll, staffSalaries, supplies } } }.
 */
async function monthly(businessId, timezone, fromMonth, toMonth) {
  const from = `${fromMonth}-01`;
  const to = m.monthEnd(toMonth);
  const localMonth = (col) => knex.raw(`DATE_FORMAT(${lib.localDateSql(col, timezone).toString()}, '%Y-%m')`);
  const [inv, online, refunds, exp, docPay, staffPay, supplies, methods] = await Promise.all([
    lib.whereLocalDates(knex('invoices as i').where('i.business_id', businessId), 'i.created_at', from, to, timezone)
      .groupBy('mon').select(localMonth('i.created_at').wrap('', ' as mon'))
      .sum({ v: 'i.amount' }).sum({ disc: 'i.discount_amount' }).count({ n: '*' }),
    lib.whereLocalDates(knex('invoices as i').join('payments as p', function j() { this.on('p.invoice_id', 'i.id').andOn('p.business_id', 'i.business_id'); })
      .where('i.business_id', businessId).where('p.status', 'paid'), 'i.created_at', from, to, timezone)
      .groupBy('mon').select(localMonth('i.created_at').wrap('', ' as mon')).sum({ v: 'i.amount' }),
    lib.whereLocalDates(knex('payments as p').where('p.business_id', businessId).where('p.status', 'refunded'), 'p.refunded_at', from, to, timezone)
      .groupBy('mon').select(localMonth('p.refunded_at').wrap('', ' as mon')).sum({ v: 'p.refunded_amount' }),
    knex('expenses').where({ business_id: businessId }).whereBetween('date', [from, to])
      .groupBy('mon', 'category').select(knex.raw("DATE_FORMAT(date, '%Y-%m') as mon"), 'category').sum({ v: 'amount' }),
    knex('payroll_payments').where({ business_id: businessId }).whereBetween('period', [fromMonth, toMonth])
      .groupBy('period').select('period').sum({ net: 'net_pay' }).sum({ adv: 'advances' }),
    staff.paidByMonth(businessId, fromMonth, toMonth),
    // Supplies received (memo): every delivery in the month it arrived — partial ones and those of later-cancelled orders too.
    lib.whereLocalDates(knex('purchase_receipts as r').where({ 'r.business_id': businessId }), 'r.received_at', from, to, timezone)
      .groupBy('mon').select(localMonth('r.received_at').wrap('', ' as mon'))
      .select(knex.raw('COALESCE(SUM(r.quantity * COALESCE(r.unit_cost, 0)), 0) as v')),
    // Revenue by payment method from the payment parts (a cash + card invoice adds to both; never "mixed").
    payParts.totalsByMethodGrouped(lib.whereLocalDates(knex('invoices as i').where('i.business_id', businessId), 'i.created_at', from, to, timezone),
      'i.id', businessId, localMonth),
  ]);
  const months = {};
  m.monthsBetween(fromMonth, toMonth).forEach((k) => { months[k] = { revenue: 0, discounts: 0, invoices: 0, online: 0, refunds: 0, byCat: {}, byMethod: {}, opex: 0, doctorPayroll: 0, staffSalaries: 0, supplies: 0 }; });
  const at = (k) => months[ym(k)];
  inv.forEach((r) => { const x = at(r.mon); if (x) { x.revenue = m.round(num(r.v)); x.discounts = m.round(num(r.disc)); x.invoices = num(r.n); } });
  online.forEach((r) => { const x = at(r.mon); if (x) x.online = m.round(num(r.v)); });
  refunds.forEach((r) => { const x = at(r.mon); if (x) x.refunds = m.round(num(r.v)); });
  exp.forEach((r) => { const x = at(r.mon); if (x) { x.byCat[r.category] = m.round((x.byCat[r.category] || 0) + num(r.v)); x.opex = m.round(x.opex + num(r.v)); } });
  docPay.forEach((r) => { const x = at(r.period); if (x) x.doctorPayroll = m.round(num(r.net) + num(r.adv)); });
  Object.entries(staffPay).forEach(([k, v]) => { const x = at(k); if (x) x.staffSalaries = v; });
  supplies.forEach((r) => { const x = at(r.mon); if (x) x.supplies = m.round(num(r.v)); });
  methods.forEach((v, k) => { const x = at(k); if (x) x.byMethod = v; });
  return months;
}

/** Sums monthly figures over a list of months. */
function sum(months, keys) {
  const t = { revenue: 0, discounts: 0, invoices: 0, online: 0, refunds: 0, byCat: {}, byMethod: {}, opex: 0, doctorPayroll: 0, staffSalaries: 0, supplies: 0 };
  keys.forEach((k) => {
    const x = months[k];
    if (!x) return;
    ['revenue', 'discounts', 'invoices', 'online', 'refunds', 'opex', 'doctorPayroll', 'staffSalaries', 'supplies'].forEach((f) => { t[f] = m.round(t[f] + x[f]); });
    Object.entries(x.byCat).forEach(([c, v]) => { t.byCat[c] = m.round((t.byCat[c] || 0) + v); });
    Object.entries(x.byMethod || {}).forEach(([k, v]) => { t.byMethod[k] = m.round((t.byMethod[k] || 0) + v); });
  });
  return t;
}

/** Income statement of a totals object (see sum()). */
function toStatement(t) {
  const expenses = Object.entries(t.byCat).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
  return { ...m.statement({ revenue: t.revenue, discounts: t.discounts, expenses, doctorPayroll: t.doctorPayroll, staffSalaries: t.staffSalaries, suppliesReceived: t.supplies }),
    invoices: t.invoices, online: t.online, refunds: t.refunds,
    // "of which" lines: revenue by payment method (parts), largest first.
    byMethod: Object.entries(t.byMethod || {}).filter(([, v]) => v).map(([method, amount]) => ({ method, amount })).sort((a, b) => b.amount - a.amount),
    // A clinic that also records staff pay as an expense ("staff salaries" category) in a month it ran staff payroll.
    salaryOverlap: (t.byCat.staff_salaries || 0) > 0 && t.staffSalaries > 0 };
}

/** Statement for a resolved period (math.resolvePeriod) with the previous period for comparison and a 12-month trend. */
async function build(ctx, period) {
  const prev = m.resolvePeriod(period.prevKind, period.prevKey, `${period.fromMonth}-01`);
  const trendFrom = m.addMonths(period.toMonth, -11);
  const earliest = [prev.fromMonth, trendFrom].sort()[0];
  const months = await monthly(ctx.businessId, ctx.timezone, earliest, period.toMonth);
  const cur = toStatement(sum(months, period.months));
  const before = toStatement(sum(months, prev.months));
  const trend = m.monthsBetween(trendFrom, period.toMonth).map((k) => {
    const s = toStatement(sum(months, [k]));
    return { month: k, revenue: s.revenue, costs: s.costs, net: s.net };
  });
  return { period, prev, cur, before, trend };
}

/** Net profit of one month (used by partner distributions). */
async function monthNet(ctx, month) {
  const months = await monthly(ctx.businessId, ctx.timezone, month, month);
  return toStatement(sum(months, [month]));
}

module.exports = { monthly, sum, toStatement, build, monthNet };
