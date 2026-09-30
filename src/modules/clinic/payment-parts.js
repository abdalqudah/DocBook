// How invoices were paid, part by part (worker: invoice).
//
// The cashier stores every payment as parts in invoice_payments: cash, card, bank_transfer, digital_wallet and
// insurance (the insurer's share). invoices.payment_method keeps a one-word summary ('mixed' when there are several
// parts) — that summary is NEVER shown: lists, filters, totals, reports and exports use the parts, e.g.
// "Cash 20.000 + Card 20.000" or "Insurance (Nat Health) 32.000 + Cash 8.000".
// Invoices without parts (issued before the table existed, or by flows that write none — front desk, online
// payments, telehealth) count as ONE part: invoices.payment_method × invoices.amount.
const knex = require('../../db/knex');

/** Methods in display order. 'other' only ever holds a legacy 'mixed' invoice that has no parts (never expected). */
const METHODS = ['cash', 'card', 'bank_transfer', 'digital_wallet', 'insurance'];
const n = (v) => Number(v) || 0;
const r3 = (v) => Math.round(n(v) * 1000) / 1000;
/** A stored method as a breakdown key: the five methods, else 'other' (a summary like 'mixed' is not a method). */
const keyOf = (m) => (METHODS.includes(m) ? m : 'other');

/** Map invoice id → [{ method, amount, received, change }] (only invoices that have parts). */
async function partsMap(businessId, invoiceIds, trx = knex) {
  const ids = [...new Set((invoiceIds || []).map(Number).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = await trx('invoice_payments').where('business_id', businessId).whereIn('invoice_id', ids).orderBy('id')
    .select('invoice_id', 'method', 'amount', 'received', 'change_due');
  rows.forEach((r) => {
    if (!map.has(r.invoice_id)) map.set(r.invoice_id, []);
    map.get(r.invoice_id).push({ method: r.method, amount: n(r.amount), received: r.received === null ? null : n(r.received), change: r.change_due === null ? null : n(r.change_due) });
  });
  return map;
}

/**
 * The parts of one invoice, in display order (insurance first, then what the patient paid): its stored parts, or
 * one part from payment_method / amount when it has none.
 */
function partsOf(inv, map) {
  const own = map && map.get(inv.id);
  const list = own && own.length ? own : [{ method: inv.payment_method, amount: n(inv.amount) }];
  return list.map((p) => ({ ...p, method: keyOf(p.method) }))
    .sort((a, b) => (a.method === 'insurance' ? 0 : 1) - (b.method === 'insurance' ? 0 : 1));
}

/** Adds .parts to each invoice row (one query for all of them). */
async function attach(businessId, rows, trx = knex) {
  const map = await partsMap(businessId, rows.map((r) => r.id), trx);
  rows.forEach((r) => { r.parts = partsOf(r, map); });
  return rows;
}

/**
 * Pure aggregation (tests use it): totals by method over invoices and their parts map.
 * → { byMethod: { cash: { amount, invoices }, … }, rows: [{ method, amount, invoices }] (largest first), total, count }
 * An invoice paid cash + card counts once under cash and once under card (invoices = invoices having that part).
 */
function aggregate(invoices, map) {
  const byMethod = {};
  let total = 0;
  invoices.forEach((inv) => {
    total += n(inv.amount);
    const seen = new Set();
    partsOf(inv, map).forEach((p) => {
      const m = p.method;
      if (!byMethod[m]) byMethod[m] = { amount: 0, invoices: 0 };
      byMethod[m].amount = r3(byMethod[m].amount + p.amount);
      if (!seen.has(m)) { byMethod[m].invoices += 1; seen.add(m); }
    });
  });
  return { byMethod, rows: toRows(byMethod), total: r3(total), count: invoices.length };
}

const toRows = (byMethod) => Object.entries(byMethod).map(([method, x]) => ({ method, amount: r3(x.amount), invoices: x.invoices }))
  .sort((a, b) => b.amount - a.amount || METHODS.indexOf(a.method) - METHODS.indexOf(b.method));

/**
 * Totals by method for the invoices a query selects, computed in SQL from the parts (fallback: invoices without
 * parts count under their payment_method).
 *   invQuery  a knex builder over invoices (any alias, any joins/filters, no limit)
 *   idCol     its invoice-id column, e.g. 'invoices.id' or 'i.id'
 * → same shape as aggregate(): { byMethod, rows, total, count }
 */
async function totalsByMethod(invQuery, idCol, businessId) {
  const union = partsUnion(invQuery, idCol, businessId);
  const [rows, [sum]] = await Promise.all([
    knex.from(union.as('x')).groupBy('x.method').select('x.method')
      .select(knex.raw('COALESCE(SUM(x.amount), 0) AS v'), knex.raw('COUNT(DISTINCT x.invoice_id) AS c')),
    invQuery.clone().clearSelect().clearOrder().select(knex.raw('COUNT(*) AS c'), knex.raw(`COALESCE(SUM(${amountColOf(idCol)}), 0) AS v`)),
  ]);
  const byMethod = {};
  rows.forEach((r) => {
    const m = keyOf(r.method);
    if (!byMethod[m]) byMethod[m] = { amount: 0, invoices: 0 };
    byMethod[m].amount = r3(byMethod[m].amount + n(r.v));
    byMethod[m].invoices += n(r.c);
  });
  return { byMethod, rows: toRows(byMethod), total: r3(sum.v), count: n(sum.c) };
}
const amountColOf = (idCol) => idCol.replace(/\.id$/, '.amount');

/** The parts of the invoices a query selects, as a derived table x(invoice_id, method, amount) (fallback included). */
function partsUnion(invQuery, idCol, businessId) {
  const ids = () => invQuery.clone().clearSelect().clearOrder().select(idCol);
  return knex.select('ip.invoice_id', 'ip.method', 'ip.amount').from('invoice_payments as ip')
    .where('ip.business_id', businessId).whereIn('ip.invoice_id', ids())
    .unionAll(function fallback() {
      this.select('fi.id as invoice_id', 'fi.payment_method as method', 'fi.amount').from('invoices as fi')
        .where('fi.business_id', businessId).whereIn('fi.id', ids())
        .whereNotExists(knex('invoice_payments as np').whereRaw('np.invoice_id = fi.id').select(knex.raw('1')));
    });
}

/**
 * Totals by method per group (e.g. per month) for the invoices a query selects.
 *   keyOfInvoice(col) → a knex.raw SQL expression over the invoice column `col` ('g.created_at'), e.g. a local month
 * → Map key → { method: amount }
 */
async function totalsByMethodGrouped(invQuery, idCol, businessId, keyOfInvoice) {
  const rows = await knex.from(partsUnion(invQuery, idCol, businessId).as('x')).join('invoices as g', 'g.id', 'x.invoice_id')
    .groupBy('k', 'x.method').select(keyOfInvoice('g.created_at').wrap('', ' AS k'), 'x.method')
    .select(knex.raw('COALESCE(SUM(x.amount), 0) AS v'));
  const out = new Map();
  rows.forEach((r) => {
    const k = r.k instanceof Date ? r.k.toISOString().slice(0, 10) : String(r.k);
    if (!out.has(k)) out.set(k, {});
    const m = keyOf(r.method);
    out.get(k)[m] = r3((out.get(k)[m] || 0) + n(r.v));
  });
  return out;
}

/**
 * Keeps the invoices that have a part paid by `method` (an invoice paid cash + card matches both "cash" and
 * "card"); invoices without parts match on their payment_method. `idCol` / `methodCol`: the query's own columns.
 */
function whereHasMethod(q, method, idCol = 'invoices.id', methodCol = 'invoices.payment_method') {
  return q.andWhere((w) => {
    w.whereExists(knex('invoice_payments as hm').whereRaw('hm.invoice_id = ??', [idCol]).where('hm.method', method).select(knex.raw('1')))
      .orWhere((w2) => {
        w2.whereNotExists(knex('invoice_payments as hn').whereRaw('hn.invoice_id = ??', [idCol]).select(knex.raw('1'))).where(methodCol, method);
      });
  });
}

/**
 * The label of one part: "Cash", "Card", "Insurance (Nat Health)" … (t = the request's translator).
 */
function partLabel(t, method, insuranceName) {
  const m = keyOf(method);
  if (m === 'insurance' && insuranceName) return t('invoicex.insurance_of', { name: insuranceName });
  return t(`invoicex.m.${m}`);
}

/**
 * A one-line breakdown for exports and plain text: "Cash 20.000 + Card 20.000". A single part is just its label
 * (the amount is the invoice total). amount = a number formatter.
 */
function describe(t, parts, { insuranceName = null, amount = (v) => String(v) } = {}) {
  const list = (parts || []).filter((p) => p && p.method);
  if (!list.length) return '';
  if (list.length === 1) return partLabel(t, list[0].method, insuranceName);
  return list.map((p) => `${partLabel(t, p.method, insuranceName)} ${amount(p.amount)}`).join(' + ');
}

/** Amount paid by `method` in a list of parts (0 when none) — per-method export columns. */
const amountBy = (parts, method) => r3((parts || []).filter((p) => p.method === method).reduce((s, p) => s + n(p.amount), 0));

module.exports = { METHODS, keyOf, partsMap, partsOf, attach, aggregate, totalsByMethod, totalsByMethodGrouped, whereHasMethod, partLabel, describe, amountBy };
