// Cashier (POS-style patient payments) and cash-drawer closings.
//
// Reception & cash screen (round 8): the bill starts from the doctor's lines (appointments.doctor_lines, set when the
// doctor presses "Finish visit"); changing what the doctor set needs a reason. Insurance takes its share first
// (percent or fixed amount), the patient pays the rest by cash, card, mixed (cash + card, the two parts must add up),
// bank transfer / CliQ or a digital wallet. Every payment is stored as parts in invoice_payments; the drawer's
// expected cash counts ONLY the cash parts (older invoices without parts fall back to payment_method = 'cash').
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
const notifications = require('../notifications/notification.service');
const scheduling = require('./scheduling');

const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'insurance', 'digital_wallet'];
/** What the cashier can choose for the patient's part: the single methods + "mixed" (cash + card). */
const PAY_METHODS = ['cash', 'card', 'mixed', 'insurance', 'bank_transfer', 'digital_wallet'];

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
  's.name as service_name', 's.name_en as service_name_en', 's.price as service_price', 'a.doctor_lines', 'a.doctor_finished_at'];

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
const recentReceipts = async (ctx, limit = 10) => require('./payment-parts').attach(ctx.businessId, // eslint-disable-line global-require
  await todayInvoices(ctx).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit)
    .select('id', 'invoice_number', 'patient_name', 'amount', 'payment_method', 'change_due', 'created_at', 'insurance_provider_name')); // + .parts (never "mixed")

/** Payment parts of invoices (Map invoice id → [{ method, amount, received, change_due }]). */
async function partsFor(ctx, invoiceIds, trx = knex) {
  const ids = [...new Set((invoiceIds || []).map(Number).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = await trx('invoice_payments').where('business_id', ctx.businessId).whereIn('invoice_id', ids).orderBy('id').select('invoice_id', 'method', 'amount', 'received', 'change_due');
  rows.forEach((r) => { if (!map.has(r.invoice_id)) map.set(r.invoice_id, []); map.get(r.invoice_id).push({ method: r.method, amount: n(r.amount), received: r.received === null ? null : n(r.received), change: r.change_due === null ? null : n(r.change_due) }); });
  return map;
}

/** An invoice's parts, or one part from payment_method/amount for invoices issued without parts. */
const partsOf = (inv, map) => (map.get(inv.id) && map.get(inv.id).length ? map.get(inv.id) : [{ method: inv.payment_method, amount: n(inv.amount) }]);

/** Today's collections by payment method (parts: a mixed receipt adds to cash AND card) + number of receipts. */
async function todayTotals(ctx) {
  const invs = await todayInvoices(ctx).select('id', 'amount', 'payment_method');
  const map = await partsFor(ctx, invs.map((i) => i.id));
  const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0]));
  let total = 0;
  invs.forEach((inv) => {
    total += n(inv.amount);
    partsOf(inv, map).forEach((p) => { byMethod[p.method] = round(n(byMethod[p.method]) + p.amount, ctx.currency); });
  });
  return { byMethod, total: round(total, ctx.currency), count: invs.length };
}

// ---------------------------------------------------------------- cash screen & reception board
/**
 * Where a visit of today stands, in the order reception works: expected → arrived → with the doctor →
 * ready to collect (finished, not paid) → paid. missed = no-show / cancelled.
 */
function flowState(a) {
  if (a.status === 'cancelled' || a.status === 'no_show') return 'missed';
  const open = a.status === 'pending' || a.status === 'confirmed';
  // An online consultation paid in advance stays in the flow until the call is done.
  if (a.payment_status === 'paid' && !(a.appointment_type === 'online' && open)) return 'paid';
  // Finished by the doctor (doctor-flow stamps doctor_finished_at and completes the visit): reception collects now.
  if (a.status === 'completed' || a.doctor_finished_at) return 'ready';
  if (a.with_doctor) return 'with_doctor';
  if (a.checked_in) return 'arrived';
  return 'expected';
}
const FLOW = ['expected', 'arrived', 'with_doctor', 'ready', 'paid'];

/** Doctors working on a date: active, the weekday enabled in their hours and not on a day off. */
async function doctorsWorking(ctx, date) {
  const [docs, off] = await Promise.all([
    knex('doctors').where({ business_id: ctx.businessId, is_active: true }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }])
      .select('id', 'full_name', 'full_name_en', 'color', 'working_hours'),
    knex('doctor_days_off').where({ business_id: ctx.businessId, off_date: date }).pluck('doctor_id'),
  ]);
  const key = scheduling.dayKeyOf(date);
  return docs.map((d) => {
    const wh = parseJson(d.working_hours, {}) || {};
    return { id: d.id, full_name: d.full_name, full_name_en: d.full_name_en, color: d.color, works: scheduling.normalizeDayConfig(wh[key]).enabled && !off.includes(d.id) };
  });
}

/**
 * Today's visits with their flow state, plus the papers each one has (invoice, prescriptions, certificates) for
 * the "Print" menus. Scoped to a doctor's own visits for a doctor login.
 */
async function today(ctx, { doctor } = {}) {
  const q = knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
    .where({ 'a.business_id': ctx.businessId, 'a.appointment_date': ctx.today }).whereNot('a.appointment_type', 'blocked')
    .orderBy('a.appointment_time').select(VISIT_SELECT.concat(['a.source', 'a.patient_email', 'a.paid_at']));
  if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId);
  if (doctor) q.where('a.doctor_id', doctor === 'none' ? null : Number(doctor));
  const rows = await q;
  const ids = rows.map((a) => a.id);
  const [invs, rxs, certs, intake] = ids.length ? await Promise.all([
    knex('invoices').where('business_id', ctx.businessId).whereIn('appointment_id', ids).orderBy('id').select('id', 'appointment_id', 'invoice_number', 'amount', 'payment_method'),
    knex('prescriptions').where('business_id', ctx.businessId).whereIn('appointment_id', ids).orderBy('id').select('id', 'appointment_id'),
    ctx.permissions && (ctx.permissions.has('certificates.view') || ctx.permissions.has('certificates.issue'))
      ? knex('certificates').where('business_id', ctx.businessId).whereIn('appointment_id', ids).whereNull('revoked_at').orderBy('id').select('id', 'appointment_id', 'doc_type', 'serial').catch(() => [])
      : [],
    // What was noted while the patient waited (vital signs, chief complaint) — for the reception board.
    knex('consultations').where('business_id', ctx.businessId).whereIn('appointment_id', ids).select('appointment_id', 'vital_signs', 'chief_complaint'),
  ]) : [[], [], [], []];
  const intakeBy = new Map(intake.map((c) => { let v = {}; try { v = typeof c.vital_signs === 'string' ? JSON.parse(c.vital_signs) || {} : (c.vital_signs || {}); } catch { v = {}; } return [c.appointment_id, { vitals: v, complaint: c.chief_complaint || '' }]; }));
  const by = (list) => { const m = new Map(); list.forEach((x) => { if (!m.has(x.appointment_id)) m.set(x.appointment_id, []); m.get(x.appointment_id).push(x); }); return m; };
  const invBy = by(invs); const rxBy = by(rxs); const certBy = by(certs);
  const now = Date.now();
  return rows.map((a) => {
    const state = flowState(a);
    const doc = doctorBill(a);
    return {
      ...a, state, fromDoctor: Boolean(doc),
      due: doc ? round(doc.reduce((t, l) => t + n(l.qty) * n(l.unit_price), 0), ctx.currency) : n(a.amount_due),
      waited: state === 'arrived' ? minutesSince(a.arrived_at, now) : null,
      inRoom: state === 'with_doctor' ? minutesSince(a.called_at, now) : null,
      invoice: (invBy.get(a.id) || []).slice(-1)[0] || null, rxs: rxBy.get(a.id) || [], certs: certBy.get(a.id) || [],
      intake: intakeBy.get(a.id) || { vitals: {}, complaint: '' },
    };
  });
}

/** The cash screen: one column per doctor working today (or with visits today), ready-to-collect visits on top. */
async function screen(ctx) {
  const [visits, doctors, totals] = await Promise.all([today(ctx), doctorsWorking(ctx, ctx.today), todayTotals(ctx)]);
  const rank = { ready: 0, with_doctor: 1, arrived: 2, expected: 3, paid: 4 };
  const finished = (a) => (a.doctor_finished_at ? new Date(a.doctor_finished_at).getTime() : 0);
  const sortCol = (list) => list.filter((a) => a.state !== 'missed').sort((x, y) => rank[x.state] - rank[y.state]
    || (x.state === 'ready' ? finished(x) - finished(y) : 0) || String(x.appointment_time).localeCompare(String(y.appointment_time)));
  const cols = doctors.filter((d) => d.works || visits.some((a) => a.doctor_id === d.id))
    .filter((d) => !ctx.ownDoctorId || d.id === ctx.ownDoctorId)
    .map((d) => ({ doctor: d, visits: sortCol(visits.filter((a) => a.doctor_id === d.id)) }));
  const none = visits.filter((a) => !a.doctor_id);
  if (none.length) cols.push({ doctor: null, visits: sortCol(none) });
  const ready = visits.filter((a) => a.state === 'ready');
  return {
    cols, totals, ready: ready.length, readyTotal: round(ready.reduce((t, a) => t + a.due, 0), ctx.currency),
    readyKey: ready.map((a) => `${a.id}:${a.due}`).sort().join(','),
  };
}

// ---------------------------------------------------------------- the bill
async function visit(ctx, apptId) {
  const a = await knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
    .where({ 'a.business_id': ctx.businessId, 'a.id': Number(apptId) }).modify((q) => { if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId); })
    .first(VISIT_SELECT.concat(['a.notes']));
  if (!a || a.appointment_type === 'blocked') throw E.notFound('Appointment');
  return { ...a, stage: stageOf(a), waited: minutesSince(a.arrived_at) };
}

const parseJson = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v === null || v === undefined ? d : v); } catch { return d; } };

/**
 * What the doctor set when finishing the visit (doctor-flow): their lines, or — "amount only" — one line with the
 * amount due. null when the doctor did not set a bill.
 */
function doctorBill(a) {
  const saved = parseJson(a.doctor_lines, null);
  if (Array.isArray(saved) && saved.length) {
    return saved.map((l) => ({ name: l.name || null, name_en: l.name_en || null, service_id: l.service_id || null, qty: n(l.qty) || 1, unit_price: n(l.unit_price), ...(!l.name && !l.service_id ? { consultation: true } : {}), fromDoctor: true }));
  }
  if (a.doctor_finished_at) {
    if (a.service_id && a.service_name) return [{ name: a.service_name, name_en: a.service_name_en, service_id: a.service_id, qty: 1, unit_price: n(a.amount_due), fromDoctor: true }];
    return [{ name: null, service_id: null, qty: 1, unit_price: n(a.amount_due), consultation: true, fromDoctor: true }];
  }
  return null;
}

/** The pre-filled bill: the doctor's lines, else the booked service, else the doctor's consultation fee (else the expected fee on the visit). */
function defaultLines(a) {
  const doc = doctorBill(a);
  if (doc) return doc;
  if (a.service_id && a.service_name) return [{ name: a.service_name, name_en: a.service_name_en, service_id: a.service_id, qty: 1, unit_price: n(a.service_price) > 0 ? n(a.service_price) : n(a.amount_due) }];
  return [{ name: null, service_id: null, qty: 1, unit_price: n(a.amount_due) || n(a.consultation_fee), consultation: true }];
}

/**
 * True when the bill no longer contains every line the doctor set, unchanged (same quantity and price; names may be
 * edited and lines may be ADDED freely). Changing or removing the doctor's lines needs a reason.
 */
function changesDoctorBill(doctorLines, lines, currency) {
  if (!doctorLines || !doctorLines.length) return false;
  const pool = lines.map((l) => `${n(l.qty)}x${round(l.unit_price, currency)}`);
  return doctorLines.some((d) => {
    const i = pool.indexOf(`${n(d.qty) || 1}x${round(d.unit_price, currency)}`);
    if (i < 0) return true;
    pool.splice(i, 1);
    return false;
  });
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

const optNum = (max = 1e9) => z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : Number(String(v).replace(/,/g, ''))),
  z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.').max(max, 'Too large.').optional());
const reason = () => z.preprocess(emptyToUndefined, z.string().trim().max(255, 'Too large.').optional());

const paySchema = z.object({
  items: z.preprocess((v) => (v && !Array.isArray(v) && typeof v === 'object' ? Object.values(v) : v),
    z.array(lineSchema, { required_error: 'Add at least one item.', invalid_type_error: 'Add at least one item.' }).min(1, 'Add at least one item.').max(MAX_LINES, 'Too large.')),
  discount_type: z.preprocess(emptyToUndefined, z.enum(['percent', 'amount']).default('percent')),
  discount_value: z.preprocess((v) => (v === '' || v === null || v === undefined ? 0 : Number(String(v).replace(/,/g, ''))),
    z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.')),
  discount_reason: reason(),
  adjust_reason: reason(),
  payment_method: z.enum(PAY_METHODS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  insurance_provider_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  coverage_type: z.preprocess(emptyToUndefined, z.enum(['percent', 'amount']).default('percent')),
  coverage: z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number({ invalid_type_error: 'Enter a number.' }).min(0, 'Must be between 0 and 100.').max(100, 'Must be between 0 and 100.').optional()),
  coverage_amount: optNum(),
  split_cash: optNum(),
  split_card: optNum(),
  amount_received: optNum(),
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

/**
 * Pure settlement maths (shared by the service and its tests): who pays what, and how.
 *   total      the bill after discount
 *   insurance  { on, type: 'percent'|'amount', percent, amount } — the insurer's share comes off first;
 *              method 'insurance' ("insurance only") = the insurer pays the whole bill
 *   method     the patient's part: cash | card | mixed | bank_transfer | digital_wallet | insurance
 *   splitCash / splitCard   mixed: both parts, each above zero, must add up to the patient's part
 *   received   cash handed over (cash or the cash part of mixed): at least the cash due; the change is returned
 * → { insuranceAmount, coveragePercent, patientAmount, parts:[{ method, amount, received?, change? }], paymentMethod, received, change }
 */
function settle({ total, method, insurance = null, splitCash, splitCard, received }, currency) {
  const r = (v) => round(v, currency);
  let insuranceAmount = 0;
  let coveragePercent = null;
  if (method === 'insurance') {
    insuranceAmount = r(total);
    coveragePercent = 100;
  } else if (insurance && insurance.on) {
    if (insurance.type === 'amount') {
      const amt = r(insurance.amount || 0);
      if (amt > total) throw E.validation({ coverage_amount: 'Too large.' });
      insuranceAmount = amt;
      coveragePercent = total > 0 ? Math.round((amt / total) * 10000) / 100 : 0;
    } else {
      const pct = Number(insurance.percent || 0);
      if (pct < 0 || pct > 100) throw E.validation({ coverage: 'Must be between 0 and 100.' });
      insuranceAmount = r(total * (pct / 100));
      coveragePercent = pct;
    }
  }
  const patientAmount = r(total - insuranceAmount);
  const parts = [];
  if (insuranceAmount > 0 || method === 'insurance') parts.push({ method: 'insurance', amount: insuranceAmount });
  let cashDue = 0;
  if (patientAmount > 0) {
    if (method === 'insurance') throw E.validation({ payment_method: 'Choose a valid value.' });
    if (method === 'mixed') {
      const c = r(splitCash || 0); const k = r(splitCard || 0);
      if (!(c > 0)) throw E.validation({ split_cash: 'Too small.' });
      if (!(k > 0)) throw E.validation({ split_card: 'Too small.' });
      if (r(c + k) !== patientAmount) throw new AppError('SPLIT_MISMATCH', 'The cash and card parts must add up to the amount to pay.', 422, { split_cash: 'SPLIT_MISMATCH', split_card: 'SPLIT_MISMATCH' });
      parts.push({ method: 'cash', amount: c }, { method: 'card', amount: k });
      cashDue = c;
    } else {
      parts.push({ method, amount: patientAmount });
      if (method === 'cash') cashDue = patientAmount;
    }
  }
  let rec = null; let change = null;
  if (cashDue > 0) {
    rec = received === undefined || received === null ? cashDue : r(received);
    if (rec < cashDue) throw cashierError('CASH_SHORT', 'The amount received is less than the total.', 422, { amount_received: 'CASH_SHORT' });
    change = r(rec - cashDue);
    const cashPart = parts.find((p) => p.method === 'cash');
    cashPart.received = rec; cashPart.change = change;
  } else if (method === 'cash' && patientAmount === 0 && parts.length === 0) {
    // A free visit (total 0) paid "in cash": one zero cash part, nothing handed over.
    parts.push({ method: 'cash', amount: 0 });
  }
  const methods = [...new Set(parts.map((p) => p.method))];
  const paymentMethod = methods.length === 1 ? methods[0] : methods.length === 0 ? (method === 'mixed' ? 'cash' : method) : 'mixed';
  return { insuranceAmount, coveragePercent, patientAmount, parts, paymentMethod, received: rec, change };
}

/** Validates a payment and does its maths (no database): { d, bill, insuranceOn, s }. */
function preparePay(ctx, input) {
  const d = validate(paySchema, input);
  const bill = computeBill(d, ctx.currency);
  const insuranceOn = d.payment_method === 'insurance' || Boolean(d.insurance_provider_id);
  const s = settle({
    total: bill.total, method: d.payment_method, splitCash: d.split_cash, splitCard: d.split_card, received: d.amount_received,
    insurance: { on: insuranceOn, type: d.coverage_type, percent: d.coverage, amount: d.coverage_amount },
  }, ctx.currency);
  return { d, bill, insuranceOn, s };
}

async function pay(ctx, apptId, input) {
  const prep = preparePay(ctx, input);
  return knex.transaction((trx) => payIn(trx, ctx, apptId, input, prep));
}

/** Issues the invoice of one visit inside the caller's transaction (locks the visit: ALREADY_PAID on a second payment). */
async function payIn(trx, ctx, apptId, input, { d, bill, insuranceOn, s }) {
  // Lock the visit: two cashiers pressing "Pay" at the same time must not issue two invoices.
  const a = await trx('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
    .where({ 'a.business_id': ctx.businessId, 'a.id': Number(apptId) }).modify((q) => { if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId); })
    .forUpdate().first('a.*', 'd.full_name as doctor_name', 's.name as service_name', 's.name_en as service_name_en');
  if (!a || a.appointment_type === 'blocked') throw E.notFound('Appointment');
  if (a.payment_status === 'paid') throw E.conflict('ALREADY_PAID', 'This visit is already paid.');
  if (a.status === 'cancelled') throw E.conflict('APPOINTMENT_CANCELLED', 'This appointment is cancelled.');

  // The doctor's bill may be changed by billing staff, with a reason.
  const fromDoctor = doctorBill(a);
  const changed = changesDoctorBill(fromDoctor, bill.lines, ctx.currency);
  if (changed && !d.adjust_reason) throw new AppError('ADJUST_REASON', 'Say why the doctor\'s bill was changed.', 422, { adjust_reason: 'ADJUST_REASON' });

  // Lines that name a service must be a service of this clinic (the name is kept as typed/snapshotted).
  const serviceIds = [...new Set(bill.lines.map((l) => l.service_id).filter(Boolean))];
  if (serviceIds.length) {
    const found = await trx('services').where({ business_id: ctx.businessId }).whereIn('id', serviceIds).pluck('id');
    if (found.length !== serviceIds.length) throw E.validation({ items: 'Choose a valid value.' });
  }
  let insuranceName = null;
  if (insuranceOn && d.insurance_provider_id) {
    const ins = await trx('insurance_providers').where({ id: d.insurance_provider_id, business_id: ctx.businessId }).first('name');
    if (!ins) throw E.validation({ insurance_provider_id: 'Choose a valid value.' });
    insuranceName = ins.name;
  }
  // Commission overrides match on the invoice's service name: keep the booked service's name while its line is on the bill.
  const bookedLine = a.service_id && bill.lines.find((l) => l.service_id === a.service_id);
  const serviceName = bookedLine && a.service_name ? a.service_name : bill.lines[0].name;
  const withInsurance = s.insuranceAmount > 0 || d.payment_method === 'insurance';

  const number = await businesses.claimInvoiceNumber(ctx.businessId, trx);
  const [invId] = await trx('invoices').insert({
    business_id: ctx.businessId, invoice_number: number, appointment_id: a.id, doctor_id: a.doctor_id, patient_id: a.patient_id,
    doctor_name: a.doctor_name, service_name: serviceName, patient_name: a.patient_name, patient_phone: a.patient_phone,
    items: JSON.stringify(bill.lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unit_price, total: l.total, ...(l.service_id ? { serviceId: l.service_id } : {}) }))),
    subtotal: bill.subtotal, discount_percent: bill.discountPercent, discount_amount: bill.discountAmount, amount: bill.total,
    amount_received: s.received, change_due: s.change,
    payment_method: s.paymentMethod,
    insurance_provider_id: withInsurance ? (d.insurance_provider_id || null) : null, insurance_provider_name: withInsurance ? insuranceName : null,
    insurance_coverage_percent: withInsurance ? s.coveragePercent : null, insurance_amount: withInsurance ? s.insuranceAmount : null,
    discount_reason: bill.discountAmount > 0 ? (d.discount_reason || null) : null, adjust_reason: changed ? d.adjust_reason : null,
    created_by: ctx.userId,
  });
  if (s.parts.length) {
    await trx('invoice_payments').insert(s.parts.map((p) => ({
      business_id: ctx.businessId, invoice_id: invId, method: p.method, amount: p.amount,
      received: p.received === undefined ? null : p.received, change_due: p.change === undefined ? null : p.change,
    })));
  }
  await trx('appointments').where({ id: a.id }).update({ payment_status: 'paid', paid_at: new Date(), amount_due: bill.total, status: 'completed', with_doctor: false, updated_at: new Date() });
  await audit.record(ctx, 'invoice.created', { entityType: 'invoice', entityId: invId, newValues: {
    number, source: input.source === 'screen' ? 'cash_screen' : 'cashier', ...(input.sale ? { sale: input.sale } : {}), lines: bill.lines.length, subtotal: bill.subtotal, discount_percent: bill.discountPercent, discount_amount: bill.discountAmount,
    discount_reason: bill.discountAmount > 0 ? (d.discount_reason || null) : null, doctor_bill_changed: changed || undefined, adjust_reason: changed ? d.adjust_reason : undefined,
    amount: bill.total, method: s.paymentMethod, parts: s.parts.map((p) => `${p.method}:${p.amount}`).join(', '), received: s.received, change: s.change,
    insurance: withInsurance ? { provider: insuranceName, percent: s.coveragePercent, amount: s.insuranceAmount } : null,
  } }, trx);
  // "Invoice paid" event: in-app for billing staff, and e-mailed only to whoever Settings → Notifications routes it to.
  await notifications.notify(ctx.businessId, {
    permission: 'billing.manage', type: 'invoice.paid', title: `فاتورة مدفوعة · Invoice paid #${number} — ${a.patient_name}`,
    body: `${bill.total} ${ctx.currency || ''}`.trim(), link: `/app/billing/${invId}`, dedupeKey: `inv:${invId}:paid`,
  }, trx);
  return { id: invId, number, total: bill.total, change: s.change, patientAmount: s.patientAmount, insuranceAmount: s.insuranceAmount, parts: s.parts, method: s.paymentMethod };
}

// ---------------------------------------------------------------- one payment for several visits (cash screen)
// The cash screen collects several visits in one go (a mother paying for her two children, a family at the end of
// the day): each visit keeps its own invoice, its own discount % and its own insurance company, while the patient
// hands over one payment — cash, card, mixed (cash + card) or insurance — for the whole amount. The payment is
// spread over the invoices so that every invoice's parts add up (the drawer then counts exactly the cash parts).
const MAX_SALE = 20;
const SALE_METHODS = ['cash', 'card', 'mixed', 'insurance', 'bank_transfer', 'digital_wallet'];

const saleLineSchema = z.object({
  appointment_id: z.coerce.number({ invalid_type_error: 'Choose a valid value.' }).int().positive(),
  amount: num().pipe(z.number().min(0, 'Must be zero or more.').max(1e9, 'Too large.')),
  discount_percent: z.preprocess((v) => (v === '' || v === null || v === undefined ? 0 : Number(String(v).replace(/,/g, ''))),
    z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be between 0 and 100.').max(100, 'Must be between 0 and 100.')),
  insurance_provider_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  coverage: z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number({ invalid_type_error: 'Enter a number.' }).min(0, 'Must be between 0 and 100.').max(100, 'Must be between 0 and 100.').optional()),
  adjust_reason: reason(),
});
const saleSchema = z.object({
  lines: z.preprocess((v) => (v && !Array.isArray(v) && typeof v === 'object' ? Object.values(v) : v),
    z.array(saleLineSchema, { required_error: 'Add at least one item.', invalid_type_error: 'Add at least one item.' }).min(1, 'Add at least one item.').max(MAX_SALE, 'Too large.')),
  payment_method: z.enum(SALE_METHODS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  split_cash: optNum(),
  split_card: optNum(),
  amount_received: optNum(),
});

/**
 * Pure maths of one payment for several visits (shared by payMany and its tests).
 *   per line  total = amount − amount × discount%      insurer = total × coverage% (with a company) | total ("insurance")
 *             patient = total − insurer
 *   mixed     the cash part is spread over the lines in order, the rest of each line goes on the card
 *   cash      the change of the whole payment is returned on the last line paid in cash
 * → { lines:[{ total, discountAmount, insurance, patient, method, split_cash, split_card, received, cash, card }],
 *     total, insuranceTotal, patientTotal, cashTotal, cardTotal, received, change }
 */
function planSale({ lines, payment_method: method, split_cash: splitCash, split_card: splitCard, amount_received: received }, currency) {
  const r = (v) => round(v, currency);
  const out = lines.map((l) => {
    const bill = computeBill({ items: [{ qty: 1, unit_price: l.amount }], discount_type: 'percent', discount_value: l.discount_percent || 0 }, currency);
    let insurance = 0;
    if (method === 'insurance') insurance = bill.total;
    else if (l.insurance_provider_id && l.coverage > 0) insurance = r(bill.total * (Math.min(100, l.coverage) / 100));
    return { total: bill.total, discountAmount: bill.discountAmount, insurance, patient: r(bill.total - insurance) };
  });
  const sum = (k) => r(out.reduce((t, l) => t + l[k], 0));
  const patientTotal = sum('patient');
  let cashLeft = 0;
  if (method === 'mixed' && patientTotal > 0) {
    const c = r(splitCash || 0); const k = r(splitCard || 0);
    if (!(c > 0)) throw E.validation({ split_cash: 'Too small.' });
    if (!(k > 0)) throw E.validation({ split_card: 'Too small.' });
    if (r(c + k) !== patientTotal) throw new AppError('SPLIT_MISMATCH', 'The cash and card parts must add up to the amount to pay.', 422, { split_cash: 'SPLIT_MISMATCH', split_card: 'SPLIT_MISMATCH' });
    cashLeft = c;
  }
  out.forEach((l) => {
    l.cash = 0; l.card = 0;
    if (method === 'mixed') {
      l.cash = r(Math.min(cashLeft, l.patient)); cashLeft = r(cashLeft - l.cash); l.card = r(l.patient - l.cash);
      if (l.cash > 0 && l.card > 0) { l.method = 'mixed'; l.split_cash = l.cash; l.split_card = l.card; } else l.method = l.card > 0 ? 'card' : 'cash';
    } else {
      l.method = method;
      if (method === 'cash') l.cash = l.patient;
      if (method === 'card') l.card = l.patient;
    }
  });
  const cashTotal = sum('cash');
  let rec = null; let change = null;
  if (cashTotal > 0) {
    rec = received === undefined || received === null ? cashTotal : r(received);
    if (rec < cashTotal) throw cashierError('CASH_SHORT', 'The amount received is less than the total.', 422, { amount_received: 'CASH_SHORT' });
    change = r(rec - cashTotal);
    const cashLines = out.filter((l) => l.cash > 0);
    cashLines.forEach((l, i) => { l.received = i === cashLines.length - 1 ? r(l.cash + change) : l.cash; });
  }
  return { lines: out, total: sum('total'), insuranceTotal: sum('insurance'), patientTotal, cashTotal, cardTotal: sum('card'), received: rec, change };
}

/**
 * Pays several visits at once: one invoice per visit (numbers claimed in order), all in ONE transaction — if any
 * visit can't be paid (already paid by someone else, cancelled, the doctor's bill changed without a reason…) nothing
 * is paid and the error carries the visit (err.line = appointment id).
 *   input  { lines:[{ appointment_id, amount, discount_percent, insurance_provider_id, coverage, adjust_reason }],
 *            payment_method, split_cash, split_card, amount_received }
 *   opts   { consultationLabel } — the name of a bill line the doctor left unnamed ("Consultation")
 * An unchanged amount keeps the doctor's lines (or the booked service); a changed amount becomes one line.
 */
async function payMany(ctx, input, { consultationLabel = 'Consultation', source = 'screen' } = {}) {
  const d = validate(saleSchema, input);
  const ids = d.lines.map((l) => l.appointment_id);
  if (new Set(ids).size !== ids.length) throw E.validation({ lines: 'Choose a valid value.' });
  const plan = planSale(d, ctx.currency);
  const tag = (err, id) => { if (err && typeof err === 'object') err.line = id; return err; };

  // Build and check every visit's bill before writing anything.
  const rows = await knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
    .where('a.business_id', ctx.businessId).whereIn('a.id', ids).modify((q) => { if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId); })
    .select(VISIT_SELECT);
  const byId = new Map(rows.map((a) => [a.id, a]));
  const preps = d.lines.map((l, i) => {
    const a = byId.get(l.appointment_id);
    if (!a || a.appointment_type === 'blocked') throw tag(E.notFound('Appointment'), l.appointment_id);
    const p = plan.lines[i];
    const def = defaultLines(a);
    const named = (x) => x.name || consultationLabel;
    const same = round(def.reduce((t, x) => t + n(x.qty) * n(x.unit_price), 0), ctx.currency) === round(l.amount, ctx.currency);
    const items = same
      ? def.map((x) => ({ name: named(x), qty: n(x.qty) || 1, unit_price: n(x.unit_price), service_id: x.service_id || undefined }))
      : [{ name: def.length === 1 ? named(def[0]) : (a.service_name || consultationLabel), qty: 1, unit_price: l.amount, service_id: def.length === 1 ? (def[0].service_id || undefined) : undefined }];
    const body = {
      items, discount_type: 'percent', discount_value: l.discount_percent || 0, adjust_reason: l.adjust_reason,
      payment_method: p.method, insurance_provider_id: d.payment_method === 'insurance' || (l.insurance_provider_id && l.coverage > 0) ? l.insurance_provider_id : undefined,
      coverage_type: 'percent', coverage: d.payment_method === 'insurance' ? undefined : l.coverage,
      split_cash: p.split_cash, split_card: p.split_card, amount_received: p.received === undefined ? undefined : p.received,
      source, sale: ids.length > 1 ? ids.length : undefined,
    };
    try { return { id: l.appointment_id, body, prep: preparePay(ctx, body) }; } catch (e) { throw tag(e, l.appointment_id); }
  });

  const invoices = await knex.transaction(async (trx) => {
    const done = [];
    for (const x of preps) { // eslint-disable-line no-restricted-syntax
      try { done.push({ appointmentId: x.id, ...(await payIn(trx, ctx, x.id, x.body, x.prep)) }); } catch (e) { throw tag(e, x.id); } // eslint-disable-line no-await-in-loop
    }
    return done;
  });
  return { invoices, total: plan.total, insuranceTotal: plan.insuranceTotal, patientTotal: plan.patientTotal, cashTotal: plan.cashTotal, cardTotal: plan.cardTotal, received: plan.received, change: plan.change };
}

// ---------------------------------------------------------------- receipt
/** One invoice with its payment parts and bill lines, for the 80 mm receipt and the done panel. */
async function receipt(ctx, invId) {
  const inv = await knex('invoices as i').leftJoin('users as u', 'u.id', 'i.created_by').leftJoin('appointments as a', 'a.id', 'i.appointment_id')
    .where({ 'i.business_id': ctx.businessId, 'i.id': Number(invId) })
    .first('i.*', 'u.name as cashier', 'a.appointment_date', 'a.appointment_time', 'a.patient_email');
  if (!inv || (ctx.ownDoctorId && inv.doctor_id !== ctx.ownDoctorId)) throw E.notFound('Invoice');
  const map = await partsFor(ctx, [inv.id]);
  const lines = parseJson(inv.items, null);
  const insuranceAmount = inv.insurance_amount !== null && inv.insurance_amount !== undefined ? n(inv.insurance_amount)
    : (inv.insurance_coverage_percent !== null && inv.insurance_coverage_percent !== undefined ? round(n(inv.amount) * n(inv.insurance_coverage_percent) / 100, ctx.currency) : 0);
  return {
    inv, parts: partsOf(inv, map), lines: Array.isArray(lines) && lines.length ? lines : [{ name: inv.service_name, qty: 1, unitPrice: n(inv.amount) + n(inv.discount_amount), total: n(inv.amount) + n(inv.discount_amount) }],
    subtotal: inv.subtotal !== null && inv.subtotal !== undefined ? n(inv.subtotal) : n(inv.amount) + n(inv.discount_amount),
    insuranceAmount, patientAmount: round(n(inv.amount) - insuranceAmount, ctx.currency),
  };
}

// ---------------------------------------------------------------- cash drawer
const dbNow = async (trx = knex) => { const [[row]] = await trx.raw('SELECT NOW() AS now'); return row.now; };

/**
 * Cash of each invoice in a window: the sum of its cash parts (a mixed receipt counts only its cash part); invoices
 * without parts (older ones, other flows) count in full when their payment_method is cash.
 */
function cashRows(ctx, start, end, trx = knex) {
  const parts = trx('invoice_payments').where('business_id', ctx.businessId).groupBy('invoice_id')
    .select('invoice_id', knex.raw("SUM(CASE WHEN method = 'cash' THEN amount ELSE 0 END) AS cash"), knex.raw('COUNT(*) AS n')).as('p');
  return trx('invoices as i').leftJoin(parts, 'p.invoice_id', 'i.id').where('i.business_id', ctx.businessId)
    .where('i.created_at', '>', start).where('i.created_at', '<=', end)
    .whereRaw("(CASE WHEN p.n IS NULL THEN (CASE WHEN i.payment_method = 'cash' THEN 1 ELSE 0 END) ELSE (CASE WHEN p.cash > 0 THEN 1 ELSE 0 END) END) = 1");
}
const CASH_OF = 'CASE WHEN p.n IS NULL THEN i.amount ELSE p.cash END';

/** DocBook getExpectedCashForPeriod: cash taken in (start, end] — only the cash parts of mixed / insured receipts. */
async function expectedCash(ctx, start, end, trx = knex) {
  const row = await cashRows(ctx, start, end, trx).first(knex.raw(`COALESCE(SUM(${CASH_OF}), 0) AS v`), knex.raw('COUNT(*) AS c'));
  return { expected: round(n(row.v), ctx.currency), count: n(row.c) };
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
    cashRows(ctx, start, now, trx).orderBy('i.created_at').first('i.created_at'),
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
  PAYMENT_METHODS, PAY_METHODS, DENOMINATIONS, denominationsFor, SEARCH_DAYS,
  FLOW, flowState, doctorsWorking, today, screen,
  queue, search, recentReceipts, todayTotals, partsFor, partsOf, visit, doctorBill, defaultLines, changesDoctorBill, servicesFor, activeInsurance, computeBill, settle, pay, receipt, planSale, payMany, MAX_SALE,
  expectedCash, cashExpenses, openPeriod, lastClosing, close, listClosings, getClosing,
};
