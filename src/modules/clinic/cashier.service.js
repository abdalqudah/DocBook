// Cashier (POS-style patient payments) and cash-drawer closings.
//
// Payment: the bill is built from lines (booked service / doctor's fee + anything the cashier adds), a discount
// (percentage or fixed amount) and a payment method. Every figure is recomputed here — client totals are never trusted.
// The invoice keeps DocBook's fields: amount = NET paid, discount_percent / discount_amount derived from the bill,
// plus the new items JSON, subtotal, amount_received and change_due (cash).
//
// Drawer closings (ported from DocBook's POS cash register closings, getExpectedCashForPeriod /
// createCashClosing): expected cash = SUM(amount) of CASH invoices with created_at in (period_start, period_end].
// period_end is stamped by the SERVER (the database clock, the same clock that stamps invoices.created_at) at the
// moment of closing — never taken from the browser — so the next period starts exactly where this one ended and no
// receipt is counted twice or lost between two shifts. Card / transfer / insurance / wallet receipts never belong in
// a physical cash count. Cash expenses paid out of the drawer are NOT deducted from the stored expected figure
// (as in DocBook); they are only reported alongside it for information.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const { round } = require('../../core/money');
const businesses = require('../businesses/business.service');
const lib = require('./records.lib');

const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'insurance', 'digital_wallet'];
const SEARCH_DAYS = 30;
const MAX_LINES = 40;

const n = (v) => Number(v) || 0;
const cashierError = (code, message, status = 409, details) => new AppError(code, message, status, details);

/** Common denominations per currency for the drawer counter (notes and coins); a generic list otherwise. */
const DENOMINATIONS = {
  JOD: [50, 20, 10, 5, 1, 0.5, 0.25, 0.1, 0.05],
  USD: [100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01],
  EUR: [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05],
  GBP: [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1],
  SAR: [500, 100, 50, 10, 5, 1, 0.5, 0.25],
  AED: [1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.5, 0.25],
  KWD: [20, 10, 5, 1, 0.5, 0.25, 0.1, 0.05],
  QAR: [500, 100, 50, 10, 5, 1, 0.5],
  BHD: [20, 10, 5, 1, 0.5, 0.1, 0.05],
  OMR: [50, 20, 10, 5, 1, 0.5, 0.1, 0.05],
  EGP: [200, 100, 50, 20, 10, 5, 1, 0.5],
  TRY: [200, 100, 50, 20, 10, 5, 1, 0.5],
};
const DEFAULT_DENOMINATIONS = [100, 50, 20, 10, 5, 1, 0.5, 0.25];
const denominationsFor = (currency) => DENOMINATIONS[String(currency || '').toUpperCase()] || DEFAULT_DENOMINATIONS;

// ---------------------------------------------------------------- lists for the cashier screen
const VISIT_SELECT = ['a.id', 'a.patient_id', 'a.patient_name', 'a.patient_phone', 'a.appointment_date', 'a.appointment_time', 'a.status', 'a.checked_in', 'a.with_doctor',
  'a.arrived_at', 'a.called_at', 'a.amount_due', 'a.payment_status', 'a.doctor_id', 'a.service_id', 'a.appointment_type',
  'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.color as doctor_color', 'd.consultation_fee',
  's.name as service_name', 's.name_en as service_name_en', 's.price as service_price'];

function unpaidVisits(ctx) {
  const q = knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
    .where('a.business_id', ctx.businessId).where('a.payment_status', 'unpaid').whereNot('a.appointment_type', 'blocked')
    .whereNotIn('a.status', ['cancelled', 'no_show']);
  if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId);
  return q;
}

/** Stage of a visit in the clinic day (for the queue label). */
const stageOf = (a) => (a.status === 'completed' ? 'done' : a.with_doctor ? 'with_doctor' : 'waiting');
const minutesSince = (ts, now = Date.now()) => (ts ? Math.max(0, Math.round((now - new Date(ts).getTime()) / 60000)) : null);

/** Today's visits that arrived (checked in / with the doctor) or finished, and are not paid yet. Finished visits first. */
async function queue(ctx) {
  const rows = await unpaidVisits(ctx).where('a.appointment_date', ctx.today)
    .andWhere((w) => w.where('a.checked_in', true).orWhere('a.with_doctor', true).orWhere('a.status', 'completed'))
    .select(VISIT_SELECT);
  const rank = { done: 0, with_doctor: 1, waiting: 2 };
  return rows.map((a) => ({ ...a, stage: stageOf(a), waited: minutesSince(a.arrived_at) }))
    .sort((x, y) => rank[x.stage] - rank[y.stage] || String(x.appointment_time).localeCompare(String(y.appointment_time)));
}

/** Any unpaid visit of the last 30 days (up to today) matching a patient name or phone. */
async function search(ctx, term) {
  const s = String(term || '').trim();
  if (s.length < 2) return [];
  const like = lib.likeTerm(s);
  return unpaidVisits(ctx).whereBetween('a.appointment_date', [lib.addDays(ctx.today, -SEARCH_DAYS), ctx.today])
    .andWhere((w) => w.where('a.patient_name', 'like', like).orWhere('a.patient_phone', 'like', like))
    .orderBy([{ column: 'a.appointment_date', order: 'desc' }, { column: 'a.appointment_time', order: 'desc' }]).limit(20).select(VISIT_SELECT);
}

const todayInvoices = (ctx) => {
  const q = lib.whereLocalDates(knex('invoices').where('business_id', ctx.businessId), 'created_at', ctx.today, ctx.today, ctx.timezone);
  if (ctx.ownDoctorId) q.where('doctor_id', ctx.ownDoctorId);
  return q;
};

/** Last receipts issued today (for reprinting). */
const recentReceipts = (ctx, limit = 10) => todayInvoices(ctx).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit)
  .select('id', 'invoice_number', 'patient_name', 'amount', 'payment_method', 'change_due', 'created_at');

/** Today's collections by payment method + number of receipts. */
async function todayTotals(ctx) {
  const rows = await todayInvoices(ctx).groupBy('payment_method').select('payment_method').sum({ v: 'amount' }).count({ c: '*' });
  const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0]));
  let total = 0; let count = 0;
  rows.forEach((r) => { byMethod[r.payment_method] = n(r.v); total += n(r.v); count += n(r.c); });
  return { byMethod, total, count };
}

// ---------------------------------------------------------------- the bill
async function visit(ctx, apptId) {
  const a = await knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
    .where({ 'a.business_id': ctx.businessId, 'a.id': Number(apptId) }).modify((q) => { if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId); })
    .first(VISIT_SELECT.concat(['a.notes']));
  if (!a || a.appointment_type === 'blocked') throw E.notFound('Appointment');
  return { ...a, stage: stageOf(a), waited: minutesSince(a.arrived_at) };
}

/** The pre-filled bill line: the booked service, else the doctor's consultation fee (else the expected fee on the visit). */
function defaultLines(a) {
  if (a.service_id && a.service_name) return [{ name: a.service_name, name_en: a.service_name_en, service_id: a.service_id, qty: 1, unit_price: n(a.service_price) > 0 ? n(a.service_price) : n(a.amount_due) }];
  return [{ name: null, service_id: null, qty: 1, unit_price: n(a.amount_due) || n(a.consultation_fee), consultation: true }];
}

/** Active services the cashier can add (any doctor's, or this doctor's). */
const servicesFor = (ctx, doctorId) => knex('services').where({ business_id: ctx.businessId, is_active: true })
  .andWhere((w) => { w.whereNull('doctor_id'); if (doctorId) w.orWhere('doctor_id', doctorId); })
  .orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'name', 'name_en', 'price', 'doctor_id');

const activeInsurance = (ctx) => knex('insurance_providers').where({ business_id: ctx.businessId, is_active: true })
  .orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'name', 'coverage_percent');

// ---------------------------------------------------------------- pay
const num = (msg) => z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : Number(String(v).replace(/,/g, ''))),
  z.number({ required_error: 'Required.', invalid_type_error: 'Enter a number.' }).finite('Enter a number.'));

const lineSchema = z.object({
  name: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(190),
  qty: num().pipe(z.number().int('Enter a number.').min(1, 'Too small.').max(999, 'Too large.')),
  unit_price: num().pipe(z.number().min(0, 'Must be zero or more.').max(1e9, 'Too large.')),
  service_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
});

const paySchema = z.object({
  items: z.preprocess((v) => (v && !Array.isArray(v) && typeof v === 'object' ? Object.values(v) : v),
    z.array(lineSchema, { required_error: 'Add at least one item.', invalid_type_error: 'Add at least one item.' }).min(1, 'Add at least one item.').max(MAX_LINES, 'Too large.')),
  discount_type: z.preprocess(emptyToUndefined, z.enum(['percent', 'amount']).default('percent')),
  discount_value: z.preprocess((v) => (v === '' || v === null || v === undefined ? 0 : Number(String(v).replace(/,/g, ''))),
    z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.')),
  payment_method: z.enum(PAYMENT_METHODS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  insurance_provider_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  coverage: z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number({ invalid_type_error: 'Enter a number.' }).min(0, 'Must be between 0 and 100.').max(100, 'Must be between 0 and 100.').optional()),
  amount_received: z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : Number(String(v).replace(/,/g, ''))),
    z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.').max(1e9, 'Too large.').optional()),
});

/**
 * Pure bill maths (shared by the service and its tests). Lines are rounded to the currency's precision;
 * a fixed discount is stored as is and converted to a percentage for DocBook's discount_percent field.
 */
function computeBill({ items, discount_type: type, discount_value: value }, currency) {
  const lines = items.map((l) => ({ ...l, total: round(l.qty * l.unit_price, currency) }));
  const subtotal = round(lines.reduce((s, l) => s + l.total, 0), currency);
  let discountAmount = 0;
  if (type === 'amount') {
    if (value > subtotal) throw E.validation({ discount_value: 'Too large.' });
    discountAmount = round(value, currency);
  } else {
    if (value > 100) throw E.validation({ discount_value: 'Must be between 0 and 100.' });
    discountAmount = round(subtotal * (value / 100), currency);
  }
  const total = round(subtotal - discountAmount, currency);
  const discountPercent = subtotal > 0 ? Math.min(100, Math.round((discountAmount / subtotal) * 10000) / 100) : 0;
  return { lines, subtotal, discountAmount, discountPercent, total };
}

async function pay(ctx, apptId, input) {
  const d = validate(paySchema, input);
  const bill = computeBill(d, ctx.currency);
  const isCash = d.payment_method === 'cash';
  let received = null; let change = null;
  if (isCash) {
    received = d.amount_received === undefined ? bill.total : round(d.amount_received, ctx.currency);
    if (received < bill.total) throw cashierError('CASH_SHORT', 'The amount received is less than the total.', 422, { amount_received: 'CASH_SHORT' });
    change = round(received - bill.total, ctx.currency);
  }
  return knex.transaction(async (trx) => {
    // Lock the visit: two cashiers pressing "Pay" at the same time must not issue two invoices.
    const a = await trx('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
      .where({ 'a.business_id': ctx.businessId, 'a.id': Number(apptId) }).modify((q) => { if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId); })
      .forUpdate().first('a.*', 'd.full_name as doctor_name', 's.name as service_name');
    if (!a || a.appointment_type === 'blocked') throw E.notFound('Appointment');
    if (a.payment_status === 'paid') throw E.conflict('ALREADY_PAID', 'This visit is already paid.');
    if (a.status === 'cancelled') throw E.conflict('APPOINTMENT_CANCELLED', 'This appointment is cancelled.');

    // Lines that name a service must be a service of this clinic (the name is kept as typed/snapshotted).
    const serviceIds = [...new Set(bill.lines.map((l) => l.service_id).filter(Boolean))];
    if (serviceIds.length) {
      const found = await trx('services').where({ business_id: ctx.businessId }).whereIn('id', serviceIds).pluck('id');
      if (found.length !== serviceIds.length) throw E.validation({ items: 'Choose a valid value.' });
    }
    let insuranceName = null;
    if (d.payment_method === 'insurance' && d.insurance_provider_id) {
      const ins = await trx('insurance_providers').where({ id: d.insurance_provider_id, business_id: ctx.businessId }).first('name');
      if (!ins) throw E.validation({ insurance_provider_id: 'Choose a valid value.' });
      insuranceName = ins.name;
    }
    // Commission overrides match on the invoice's service name: keep the booked service's name while its line is on the bill.
    const bookedLine = a.service_id && bill.lines.find((l) => l.service_id === a.service_id);
    const serviceName = bookedLine && a.service_name ? a.service_name : bill.lines[0].name;

    const number = await businesses.claimInvoiceNumber(ctx.businessId, trx);
    const [invId] = await trx('invoices').insert({
      business_id: ctx.businessId, invoice_number: number, appointment_id: a.id, doctor_id: a.doctor_id, patient_id: a.patient_id,
      doctor_name: a.doctor_name, service_name: serviceName, patient_name: a.patient_name, patient_phone: a.patient_phone,
      items: JSON.stringify(bill.lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unit_price, total: l.total, ...(l.service_id ? { serviceId: l.service_id } : {}) }))),
      subtotal: bill.subtotal, discount_percent: bill.discountPercent, discount_amount: bill.discountAmount, amount: bill.total,
      amount_received: received, change_due: change,
      payment_method: d.payment_method, insurance_provider_id: d.payment_method === 'insurance' ? (d.insurance_provider_id || null) : null, insurance_provider_name: insuranceName,
      insurance_coverage_percent: d.payment_method === 'insurance' && d.coverage !== undefined ? d.coverage : null,
      created_by: ctx.userId,
    });
    await trx('appointments').where({ id: a.id }).update({ payment_status: 'paid', paid_at: new Date(), amount_due: bill.total, status: 'completed', with_doctor: false, updated_at: new Date() });
    await audit.record(ctx, 'invoice.created', { entityType: 'invoice', entityId: invId, newValues: {
      number, source: 'cashier', lines: bill.lines.length, subtotal: bill.subtotal, discount_percent: bill.discountPercent, discount_amount: bill.discountAmount,
      amount: bill.total, method: d.payment_method, received, change, coverage: d.payment_method === 'insurance' ? (d.coverage ?? null) : null,
    } }, trx);
    return { id: invId, number, total: bill.total, change };
  });
}

// ---------------------------------------------------------------- cash drawer
const dbNow = async (trx = knex) => { const [[row]] = await trx.raw('SELECT NOW() AS now'); return row.now; };

/** DocBook getExpectedCashForPeriod: cash invoices with created_at in (start, end]. */
async function expectedCash(ctx, start, end, trx = knex) {
  const row = await trx('invoices').where({ business_id: ctx.businessId, payment_method: 'cash' })
    .where('created_at', '>', start).where('created_at', '<=', end)
    .first(knex.raw('COALESCE(SUM(amount), 0) AS v'), knex.raw('COUNT(*) AS c'));
  return { expected: n(row.v), count: n(row.c) };
}

/** Cash expenses recorded in the same window — informational only (not deducted from the stored expected figure). */
async function cashExpenses(ctx, start, end, trx = knex) {
  const row = await trx('expenses').where({ business_id: ctx.businessId, payment_method: 'cash' })
    .where('created_at', '>', start).where('created_at', '<=', end)
    .first(knex.raw('COALESCE(SUM(amount), 0) AS v'), knex.raw('COUNT(*) AS c'));
  return { total: n(row.v), count: n(row.c) };
}

const lastClosing = (ctx, trx = knex) => trx('cash_closings').where({ business_id: ctx.businessId }).orderBy('period_end', 'desc').orderBy('id', 'desc').first();

/**
 * The open drawer period: from the last closing's period_end; with no closing yet, from the start of the clinic's
 * day (so it covers every cash receipt of today, starting with the first one).
 */
async function openPeriod(ctx, trx = knex) {
  const last = await lastClosing(ctx, trx);
  const now = await dbNow(trx);
  const start = last ? last.period_end : lib.startOfDay(ctx.today, ctx.timezone);
  const [cash, expenses, first] = await Promise.all([
    expectedCash(ctx, start, now, trx), cashExpenses(ctx, start, now, trx),
    trx('invoices').where({ business_id: ctx.businessId, payment_method: 'cash' }).where('created_at', '>', start).where('created_at', '<=', now).orderBy('created_at').first('created_at'),
  ]);
  return { start, end: now, sinceClosing: Boolean(last), last, ...cash, expenses, firstCashAt: first ? first.created_at : null };
}

const closingSchema = z.object({
  counted_cash: z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : Number(String(v).replace(/,/g, ''))),
    z.number({ required_error: 'Required.', invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.').max(1e10, 'Too large.')),
  notes: z.preprocess(emptyToUndefined, z.string().trim().max(2000).optional()),
  seen_expected: z.preprocess(emptyToUndefined, z.coerce.number().finite().optional()),
  seen_count: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
});

/**
 * DocBook createCashClosing. The period end is the database clock at insert time (never the browser's), inside a
 * transaction that locks the clinic row, so two simultaneous closings can't overlap. If new cash receipts arrived
 * since the cashier looked at the figures, the closing is refused so they can recount against the fresh total.
 */
async function close(ctx, input) {
  const d = validate(closingSchema, input);
  return knex.transaction(async (trx) => {
    await trx('businesses').where({ id: ctx.businessId }).forUpdate().first('id');
    const p = await openPeriod(ctx, trx);
    if (d.seen_count !== undefined && (d.seen_count !== p.count || (d.seen_expected !== undefined && round(d.seen_expected, ctx.currency) !== round(p.expected, ctx.currency)))) {
      throw cashierError('DRAWER_CHANGED', 'New cash receipts were recorded since you opened this page.', 409);
    }
    const counted = round(d.counted_cash, ctx.currency);
    const variance = round(counted - p.expected, ctx.currency);
    const [id] = await trx('cash_closings').insert({
      business_id: ctx.businessId, period_start: p.start, period_end: p.end, expected_cash: p.expected, counted_cash: counted, variance,
      invoice_count: p.count, closed_by: ctx.userId || null, notes: d.notes || null,
    });
    // TIMESTAMPs have one-second resolution: keep the clinic lock until the clock has left period_end's second, so a
    // receipt paid right after this closing can never share its timestamp (and fall between two periods).
    for (let i = 0; i < 15 && (await dbNow(trx)).getTime() <= new Date(p.end).getTime(); i += 1) await new Promise((r) => { setTimeout(r, 100); }); // eslint-disable-line no-await-in-loop
    await audit.record(ctx, 'cash.closed', { entityType: 'cash_closing', entityId: id, newValues: { expected: p.expected, counted, variance, receipts: p.count, period_start: p.start, period_end: p.end } }, trx);
    return { id, variance, expected: p.expected, counted };
  });
}

const closingsQuery = (ctx) => knex('cash_closings as c').leftJoin('users as u', 'u.id', 'c.closed_by').where('c.business_id', ctx.businessId)
  .orderBy('c.period_end', 'desc').orderBy('c.id', 'desc').select('c.*', 'u.name as closed_by_name');

const listClosings = (ctx, limit = 200) => closingsQuery(ctx).limit(limit);

async function getClosing(ctx, id) {
  const c = await closingsQuery(ctx).where('c.id', Number(id)).first();
  if (!c) throw E.notFound('Closing');
  return c;
}

module.exports = {
  PAYMENT_METHODS, DENOMINATIONS, denominationsFor, SEARCH_DAYS,
  queue, search, recentReceipts, todayTotals, visit, defaultLines, servicesFor, activeInsurance, computeBill, pay,
  expectedCash, cashExpenses, openPeriod, lastClosing, close, listClosings, getClosing,
};
