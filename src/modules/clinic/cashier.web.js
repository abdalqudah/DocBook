// Cashier (POS-style patient payments), the full-screen cash screen and cash-drawer closings — DocBook's cash register.
//   GET  /app/cashier                          queue of visits waiting to pay + the payment panel of ?visit=<id>    (billing.manage)
//   GET  /app/cashier/screen                   full-screen cash screen (POS): today's unpaid visits + the payment (?add=<id,…>)  (billing.manage)
//   GET  /app/cashier/screen/data              the screen's visits + today's totals as JSON (live refresh)          (billing.manage)
//   POST /app/cashier/screen/checkout          pay several visits at once (JSON) — one invoice per visit           (billing.manage)
//   GET  /app/cashier/screen/panel/:id         the payment panel of a visit (HTML fragment for the dialogs)
//   POST /app/cashier/:id/pay                  take the payment (server recomputes every figure), then ?paid=<invoice>  (billing.manage)
//   GET  /app/cashier/receipt/:id              80 mm receipt of an invoice (with its cash / card parts)             (billing.view)
//   GET  /app/cashier/receipt/batch?ids=1,2    the receipts of one cash-screen payment, one after the other         (billing.view)
//   GET  /app/cashier/papers/:id/prescription/:rx.pdf   a visit's prescription for reception to print           (billing.view)
//   GET  /app/cashier/papers/:id/(order|referral)/:oid.pdf  a visit's test request / referral for reception to print (billing.view)
//   POST /app/cashier/papers/:id/send          send the visit's prescription(s) / certificates to the patient       (billing.manage)
//   GET  /app/cashier/closings                 open drawer period + closing history                                 (billing.view)
//   POST /app/cashier/closings                 close the drawer (period end stamped by the server)                  (billing.manage)
//   GET  /app/cashier/closings/export          history export                                                       (data.export)
//   GET  /app/cashier/closings/:id             closing slip (printable)                                             (billing.view)
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const exporter = require('../../core/exporter');
const { AppError, E } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const { decimalsOf, round } = require('../../core/money');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const svc = require('./cashier.service');
const lib = require('./records.lib');

const router = express.Router();
router.use(canAny('billing.view', 'billing.manage'));

const ASSETS = { pageScripts: ['/js/cashier.js'], pageStyles: ['/css/cashier.css'] };
const PAY_ASSETS = { pageScripts: ['/js/cashier.js', '/js/cashx.js'], pageStyles: ['/css/cashier.css', '/css/cashx.css'] };
const EXPECTED_ERRORS = [404, 409, 422];
/** Where the payment panel returns to after paying (whitelist — never a free URL). */
const RETURNS = { screen: '/app/cashier/screen', 'front-desk': '/app/front-desk', cashier: '/app/cashier' };
const retOf = (v) => (Object.prototype.hasOwnProperty.call(RETURNS, v) ? v : 'cashier');

/** Human text for an AppError: this area's codes first, then the shared table, then the English message. */
function errorText(req, err) {
  for (const key of [`errors_cashx.${err.code}`, `errors_cashier.${err.code}`, `errors.${err.code}`]) { const s = req.t(key, err.details && typeof err.details === 'object' ? err.details : undefined); if (s !== key) return s; }
  return err.message;
}
function fieldErrors(req, err) {
  if (!err.details || typeof err.details !== 'object') return {};
  return Object.fromEntries(Object.entries(err.details).map(([k, v]) => {
    if (typeof v === 'string' && /^[A-Z_]+$/.test(v)) {
      for (const key of [`errors_cashx.${v}`, `errors_cashier.${v}`]) { const s = req.t(key); if (s !== key) return [k, s]; }
    }
    return [k, translateMessage(req.locale, v)];
  }));
}

// ---------------------------------------------------------------- payment panel (shared by the cashier page, the cash screen and the reception board)
/** Locals of the payment panel partial (pages/clinic/cashier/_panel.ejs) for a visit. */
async function panelLocals(req, apptId, extra = {}) {
  const { ctx } = req;
  const a = await svc.visit(ctx, apptId);
  const [services, insurance] = await Promise.all([svc.servicesFor(ctx, a.doctor_id), svc.activeInsurance(ctx)]);
  const old = extra.old || null;
  const doctorLines = svc.doctorBill(a);
  let lines = svc.defaultLines(a);
  if (old && old.items) {
    lines = (Array.isArray(old.items) ? old.items : Object.values(old.items)).map((l) => ({ name: l.name, service_id: l.service_id || null, qty: l.qty, unit_price: l.unit_price, fromDoctor: l.from_doctor === '1' }));
  }
  const inv = a.payment_status === 'paid' ? await knex('invoices').where({ business_id: ctx.businessId, appointment_id: a.id }).orderBy('id', 'desc').first('id', 'invoice_number') : null;
  return {
    bill: { a, lines, doctorLines, services, insurance, old, invoice: inv || null },
    ret: retOf(extra.ret || req.query.return), methods: svc.PAY_METHODS, decimals: decimalsOf(ctx.currency),
    errors: extra.errors || {}, formError: extra.formError || null,
  };
}

/** Locals of the "paid" panel (pages/clinic/cashier/_done.ejs): the receipt, the visit's papers, the auto-print address. */
async function doneLocals(req, res, invId, ret) {
  const { ctx } = req;
  let rec;
  try { rec = await svc.receipt(ctx, invId); } catch (e) { if (e instanceof AppError && e.status === 404) return null; throw e; }
  const rxs = rec.inv.appointment_id ? await knex('prescriptions').where({ business_id: ctx.businessId, appointment_id: rec.inv.appointment_id }).orderBy('id').select('id') : [];
  const certs = rec.inv.appointment_id && (ctx.permissions.has('certificates.view') || ctx.permissions.has('certificates.issue'))
    ? await knex('certificates').where({ business_id: ctx.businessId, appointment_id: rec.inv.appointment_id }).whereNull('revoked_at').orderBy('id').select('id', 'doc_type', 'serial')
    : [];
  // The receipt prints on its own: the 80 mm receipt — or the A4 / A5 invoice when the clinic CHOSE that paper in
  // Settings → Invoice template (a clinic that never saved the template gets the till receipt).
  const saved = await knex('clinic_ops_settings').where({ business_id: ctx.businessId }).first('invoice_template').catch(() => null);
  let paper = null;
  try { paper = saved && saved.invoice_template ? (typeof saved.invoice_template === 'string' ? JSON.parse(saved.invoice_template) : saved.invoice_template).paper : null; } catch { paper = null; }
  const autoPrint = `/app/cashier/receipt/${rec.inv.id}?autoprint=1${paper === 'a4' || paper === 'a5' ? `&paper=${paper}` : ''}`;
  const tpl = { paper: paper || 'receipt80' };
  return { done: { ...rec, rxs, certs, autoPrint, ret: retOf(ret), paper: tpl.paper } };
}

// ---------------------------------------------------------------- cashier page
async function renderScreen(req, res, extra = {}) {
  const { ctx } = req;
  const visitId = Number(req.query.visit || extra.visitId) || null;
  const [queue, results, receipts, totals, period] = await Promise.all([
    svc.queue(ctx), svc.search(ctx, req.query.q), svc.recentReceipts(ctx), svc.todayTotals(ctx),
    ctx.ownDoctorId ? null : svc.openPeriod(ctx),
  ]);
  let panel = null;
  if (visitId) {
    try {
      panel = await panelLocals(req, visitId, { ...extra, ret: 'cashier' });
    } catch (e) {
      if (!(e instanceof AppError) || e.status !== 404) throw e;
      flash(req, 'error', req.t('cashier.visit_not_found'));
    }
  }
  const done = Number(req.query.paid) ? await doneLocals(req, res, Number(req.query.paid), 'cashier') : null;
  res.status(extra.status || 200);
  return res.page('pages/clinic/cashier/index', {
    title: req.t('cashier.title'), queue, results, receipts, totals, period, panel, bill: panel ? panel.bill : null, visitId, ...(done || {}),
    searchTerm: String(req.query.q || '').trim().slice(0, 80), methods: svc.PAYMENT_METHODS, decimals: decimalsOf(ctx.currency),
    localTime: (d) => lib.localTime(d, ctx.timezone), errors: extra.errors || {}, formError: extra.formError || null, ...PAY_ASSETS,
  });
}

router.get('/', wrap(async (req, res) => {
  if (!req.ctx.permissions.has('billing.manage')) return res.redirect('/app/cashier/closings');
  return renderScreen(req, res);
}));

// ---------------------------------------------------------------- full-screen cash screen (POS)
// Today's unpaid visits as cards on one side, the payment being prepared on the other: several visits can be paid in
// one go, each with its own amount, discount % and insurance company; one payment method for the whole amount.

/** A visit as the cash screen shows it (card + prefilled line). */
function posVisit(req, a) {
  const { ctx } = req;
  const L = (ar, en) => (req.locale === 'en' && en ? en : ar);
  const lines = svc.defaultLines(a);
  const fromDoctor = Boolean(svc.doctorBill(a));
  const due = round(lines.reduce((t, l) => t + (Number(l.qty) || 1) * (Number(l.unit_price) || 0), 0), ctx.currency);
  const consult = req.t('billing.consultation');
  const clinical = ctx.permissions.has('clinical.view');
  return {
    id: a.id, patient: a.patient_name, phone: a.patient_phone || '', doctor: a.doctor_id ? L(a.doctor_name, a.doctor_name_en) || '' : '',
    doctorColor: a.doctor_color || null, time: String(a.appointment_time || '').slice(0, 5), date: a.appointment_date,
    dateText: shortDate(req, a.appointment_date), online: a.appointment_type === 'online', state: a.state || svc.flowState(a),
    due, fromDoctor, what: lines.map((l) => (req.locale === 'en' && l.name_en ? l.name_en : l.name) || consult).join(' + '),
    rxs: (a.rxs || []).map((rx) => (clinical ? `/app/visits/${a.id}/prescriptions/${rx.id}?print=1&autoprint=1` : `/app/cashier/papers/${a.id}/prescription/${rx.id}.pdf`)),
    finished: a.doctor_finished_at ? new Date(a.doctor_finished_at).getTime() : 0,
  };
}
function shortDate(req, d) {
  try { return new Intl.DateTimeFormat(req.locale === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)); } catch { return d; }
}

const POS_RANK = { ready: 0, with_doctor: 1, arrived: 2, expected: 3 };
/** Today's unpaid visits (ready to pay first), plus any visit asked for by ?add= (e.g. an older unpaid one). */
async function posData(req, addIds = []) {
  const { ctx } = req;
  const [rows, totals] = await Promise.all([svc.today(ctx), svc.todayTotals(ctx)]);
  const open = rows.filter((a) => a.payment_status !== 'paid' && a.state !== 'missed');
  const extra = [];
  for (const id of addIds.filter((x) => !open.some((a) => a.id === x))) { // eslint-disable-line no-restricted-syntax
    try {
      const a = await svc.visit(ctx, id); // eslint-disable-line no-await-in-loop
      if (a.payment_status !== 'paid' && a.status !== 'cancelled' && a.status !== 'no_show') extra.push({ ...a, state: svc.flowState(a) });
    } catch (e) { if (!(e instanceof AppError) || e.status !== 404) throw e; }
  }
  const visits = open.concat(extra).map((a) => posVisit(req, a)).sort((x, y) => (POS_RANK[x.state] ?? 4) - (POS_RANK[y.state] ?? 4)
    || (x.state === 'ready' ? x.finished - y.finished : 0) || String(x.date).localeCompare(String(y.date)) || String(x.time).localeCompare(String(y.time)));
  const ready = visits.filter((v) => v.state === 'ready');
  return { visits, totals, readyKey: ready.map((v) => `${v.id}:${v.due}`).sort().join(',') };
}

/** The clinic's chosen invoice paper (Settings → Invoice template): 'a4' | 'a5' | null (80 mm till receipt). */
async function paperOf(ctx) {
  const saved = await knex('clinic_ops_settings').where({ business_id: ctx.businessId }).first('invoice_template').catch(() => null);
  try {
    const p = saved && saved.invoice_template ? (typeof saved.invoice_template === 'string' ? JSON.parse(saved.invoice_template) : saved.invoice_template).paper : null;
    return p === 'a4' || p === 'a5' ? p : null;
  } catch { return null; }
}

const addIdsOf = (v) => String(v || '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, svc.MAX_SALE);

router.get('/screen', can('billing.manage'), wrap(async (req, res) => {
  const { ctx } = req;
  const add = addIdsOf(req.query.add);
  const canExpense = ctx.permissions.has('expenses.manage');
  const expensesSvc = canExpense ? require('../expenses/expense.service') : null; // eslint-disable-line global-require
  const [data, insurers, expCats] = await Promise.all([posData(req, add), svc.activeInsurance(ctx), canExpense ? expensesSvc.categories(ctx.businessId) : null]);
  // "Add an expense" from the cash screen (paid from the drawer): the same form as Finance → Expenses.
  const expense = canExpense ? {
    cats: expCats.system.map((k) => ({ value: k, label: res.locals.label('categories', k) })).concat(expCats.custom.map((c) => ({ value: c.key, label: c.name }))),
    methods: expensesSvc.PAYMENT_METHODS,
  } : null;
  res.set('Cache-Control', 'no-store');
  return res.page('pages/clinic/cashier/screen', {
    title: req.t('cashpos.title'), layout: 'cashscreen', bodyClass: 'pos-body', expense,
    pos: { ...data, add, insurers: insurers.map((i) => ({ id: i.id, name: i.name, coverage: Number(i.coverage_percent) || 0 })), decimals: decimalsOf(ctx.currency) },
    pageScripts: ['/js/cashpos.js'], pageStyles: ['/css/cashpos.css'],
  });
}));

router.get('/screen/data', can('billing.manage'), wrap(async (req, res) => {
  const data = await posData(req, addIdsOf(req.query.keep));
  res.set('Cache-Control', 'no-store').json(data);
}));

router.post('/screen/checkout', can('billing.manage'), wrap(async (req, res) => {
  const { ctx } = req;
  const b = req.body || {};
  try {
    const r = await svc.payMany(ctx, b, { consultationLabel: req.t('billing.consultation'), source: 'screen' });
    const paper = await paperOf(ctx);
    const ids = r.invoices.map((i) => i.id);
    const q = `autoprint=1${paper ? `&paper=${paper}` : ''}`;
    return res.json({
      ok: true, ...r,
      invoices: r.invoices.map((i) => ({ id: i.id, number: i.number, appointmentId: i.appointmentId, total: i.total, patientAmount: i.patientAmount, insuranceAmount: i.insuranceAmount, method: i.method })),
      printUrl: ids.length === 1 ? `/app/cashier/receipt/${ids[0]}?${q}` : `/app/cashier/receipt/batch?ids=${ids.join(',')}&${q}`,
    });
  } catch (err) {
    if (!(err instanceof AppError) || !EXPECTED_ERRORS.includes(err.status)) throw err;
    const fields = fieldErrors(req, err);
    const firstField = Object.keys(fields)[0];
    const message = err.code === 'VALIDATION_FAILED' && firstField ? fields[firstField] : errorText(req, err);
    return res.status(err.status).json({ ok: false, code: err.code, error: message, line: err.line || null, field: firstField || null });
  }
}));

router.get('/screen/panel/:id(\\d+)', can('billing.manage'), wrap(async (req, res) => {
  let locals;
  try { locals = await panelLocals(req, Number(req.params.id), { ret: req.query.return }); } catch (e) {
    if (e instanceof AppError && e.status === 404) return res.status(404).type('text/plain').send(req.t('cashier.visit_not_found'));
    throw e;
  }
  res.set('Cache-Control', 'no-store');
  return res.render('pages/clinic/cashier/_panel', locals);
}));

// ---------------------------------------------------------------- pay
router.post('/:id(\\d+)/pay', can('billing.manage'), wrap(async (req, res) => {
  const apptId = Number(req.params.id);
  const ret = retOf(req.body.return);
  try {
    const r = await svc.pay(req.ctx, apptId, { ...req.body, source: ret === 'screen' ? 'screen' : 'cashier' });
    const change = r.change ? req.t('cashier.change_toast', { v: res.locals.fmt.money(r.change) }) : '';
    flash(req, 'success', [req.t('cashier.paid_toast', { n: r.number, v: res.locals.fmt.money(r.total) }), change].filter(Boolean).join(' · '));
    if (req.body.intent === 'print') return res.redirect(`/app/billing/${r.id}?print=1&autoprint=1`);
    return res.redirect(`${RETURNS[ret]}?paid=${r.id}`);
  } catch (err) {
    if (!(err instanceof AppError) || !EXPECTED_ERRORS.includes(err.status)) throw err;
    if (err.code === 'ALREADY_PAID' || err.status === 404) { flash(req, 'error', errorText(req, err)); return res.redirect(RETURNS[ret]); }
    const extra = { status: err.status, old: req.body, errors: fieldErrors(req, err), formError: { code: err.code, message: errorText(req, err) }, visitId: apptId };
    if (ret === 'front-desk') {
      const panel = await panelLocals(req, apptId, { ...extra, ret });
      res.status(err.status);
      return require('./frontdesk.web').renderBoard(req, res, { panel }); // eslint-disable-line global-require
    }
    req.query.visit = String(apptId);
    return renderScreen(req, res, extra);
  }
}));

// ---------------------------------------------------------------- receipt & papers
/** The receipt may be framed by this site only (the cash screen prints it in a hidden frame); every other page keeps frame-ancestors 'none'. */
function allowSameOriginFrame(res) {
  const csp = res.getHeader('Content-Security-Policy');
  if (csp) res.setHeader('Content-Security-Policy', /frame-ancestors[^;]*/.test(csp) ? String(csp).replace(/frame-ancestors[^;]*/, "frame-ancestors 'self'") : `${csp};frame-ancestors 'self'`);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

router.get('/receipt/:id(\\d+)', wrap(async (req, res) => {
  const rec = await svc.receipt(req.ctx, Number(req.params.id));
  allowSameOriginFrame(res);
  res.page('pages/clinic/cashier/receipt', { paper: ['a4', 'a5'].includes(req.query.paper) ? req.query.paper : 'receipt80',
    title: req.t('cashx.receipt_no', { n: rec.inv.invoice_number }), layout: 'cashscreen', bodyClass: 'cx-receipt-page', paperLight: true, rec,
    issued: lib.localTime(rec.inv.created_at, req.ctx.timezone), pageStyles: ['/css/cashx.css'], pageScripts: ['/js/cashx.js'],
  });
}));

router.get('/receipt/batch', wrap(async (req, res) => {
  const ids = [...new Set(addIdsOf(req.query.ids))];
  if (!ids.length) throw E.notFound('Invoice');
  const recs = [];
  for (const id of ids) recs.push(await svc.receipt(req.ctx, id)); // eslint-disable-line no-await-in-loop
  allowSameOriginFrame(res);
  res.page('pages/clinic/cashier/receipt-batch', { paper: ['a4', 'a5'].includes(req.query.paper) ? req.query.paper : 'receipt80',
    title: req.t('cashpos.batch_title'), layout: 'cashscreen', bodyClass: 'cx-receipt-page', paperLight: true,
    recs: recs.map((rec) => ({ rec, issued: lib.localTime(rec.inv.created_at, req.ctx.timezone) })), pageStyles: ['/css/cashx.css', '/css/cashpos.css'], pageScripts: ['/js/cashx.js'],
  });
}));

router.get('/papers/:id(\\d+)/prescription/:rx(\\d+).pdf', wrap(async (req, res) => {
  const docs = require('../patientdocs/docs.service'); // eslint-disable-line global-require
  const apptId = Number(req.params.id);
  const out = await docs.render(req.ctx, apptId, { kind: 'prescription', ref_id: Number(req.params.rx) }, req.query.lang === 'en' || req.query.lang === 'ar' ? req.query.lang : (req.locale === 'en' ? 'en' : 'ar'));
  await audit.record(req.ctx, 'patient_docs.downloaded', { entityType: 'appointment', entityId: apptId, newValues: { kind: 'prescription', ref: Number(req.params.rx), by: 'reception' } });
  res.set({
    'Content-Type': 'application/pdf', 'Content-Length': String(out.pdf.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${out.filename}"`,
  });
  return res.end(out.pdf);
}));

// A visit's test request (lab / imaging) or referral letter for reception to print — the sheet the patient takes along.
router.get('/papers/:id(\\d+)/:kind(order|referral)/:oid(\\d+).pdf', wrap(async (req, res) => {
  const docs = require('../patientdocs/docs.service'); // eslint-disable-line global-require
  const apptId = Number(req.params.id);
  const out = await docs.orderPdf(req.ctx, req.params.kind, Number(req.params.oid), req.query.lang === 'en' || req.query.lang === 'ar' ? req.query.lang : (req.locale === 'en' ? 'en' : 'ar'));
  if (out.doc.appointment_id !== apptId) throw E.notFound('Order');
  await audit.record(req.ctx, 'patient_docs.downloaded', { entityType: 'appointment', entityId: apptId, newValues: { kind: req.params.kind, ref: out.doc.id, by: 'reception' } });
  res.set({
    'Content-Type': 'application/pdf', 'Content-Length': String(out.pdf.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${out.filename}"`,
  });
  return res.end(out.pdf);
}));

// Reception hands the papers over: prescriptions and certificates only (never the clinical report — that stays with clinical staff).
router.post('/papers/:id(\\d+)/send', can('billing.manage'), wrap(async (req, res) => {
  const docs = require('../patientdocs/docs.service'); // eslint-disable-line global-require
  const { publicBase } = require('../../middleware/web'); // eslint-disable-line global-require
  const apptId = Number(req.params.id);
  req.ctx.baseUrl = publicBase(req);
  try {
    const r = await docs.share(req.ctx, apptId, { rx: req.body.rx, cert: req.body.cert, locale: req.body.locale === 'en' ? 'en' : req.locale === 'en' ? 'en' : 'ar' });
    flash(req, 'success', req.t('patient_docs.sent', { n: r.shared }) + (r.emailed ? ` ${req.t('patient_docs.sent_mail')}` : ''));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', e.code === 'VALIDATION_FAILED' ? req.t('patient_docs.nothing_chosen') : errorText(req, e));
  }
  return res.redirect(RETURNS[retOf(req.body.return)]); // back to the board
}));

// ---------------------------------------------------------------- drawer closings
function denyDoctorScope(req) {
  // The drawer is the whole clinic's cash: a login limited to one doctor's visits doesn't see it.
  if (req.ctx.ownDoctorId) throw E.forbidden('appointments.view_all');
}

async function renderClosings(req, res, extra = {}) {
  denyDoctorScope(req);
  const [period, closings] = await Promise.all([svc.openPeriod(req.ctx), svc.listClosings(req.ctx)]);
  res.status(extra.status || 200);
  return res.page('pages/clinic/cashier/closings', {
    title: req.t('cashier.closings_title'), period, closings, denominations: svc.denominationsFor(req.ctx.currency), decimals: decimalsOf(req.ctx.currency),
    localTime: (d) => lib.localTime(d, req.ctx.timezone), errors: extra.errors || {}, formError: extra.formError || null, old: extra.old || {}, ...ASSETS,
  });
}

router.get('/closings', wrap((req, res) => renderClosings(req, res)));

router.post('/closings', can('billing.manage'), wrap(async (req, res) => {
  denyDoctorScope(req);
  try {
    const r = await svc.close(req.ctx, req.body);
    const fmt = res.locals.fmt;
    const key = r.variance === 0 ? 'cashier.closed_even' : r.variance > 0 ? 'cashier.closed_over' : 'cashier.closed_short';
    flash(req, 'success', req.t(key, { v: fmt.money(Math.abs(r.variance)) }));
    return res.redirect(`/app/cashier/closings/${r.id}`);
  } catch (err) {
    if (!(err instanceof AppError) || !EXPECTED_ERRORS.includes(err.status)) throw err;
    const old = err.code === 'DRAWER_CHANGED' ? { ...req.body, counted_cash: req.body.counted_cash } : req.body;
    return renderClosings(req, res, { status: err.status, old, errors: fieldErrors(req, err), formError: { code: err.code, message: errorText(req, err) } });
  }
}));

router.get('/closings/export', can('data.export'), wrap(async (req, res) => {
  denyDoctorScope(req);
  const rows = await svc.listClosings(req.ctx, 50000);
  const tz = req.ctx.timezone;
  const t = req.t;
  const stamp = (d) => { const l = lib.localTime(d, tz) || {}; return `${l.date || ''} ${l.time || ''}`.trim(); };
  exporter.send(req, res, {
    name: t('cashier.closings_title'),
    header: [t('cashier.closing_no'), t('cashier.period_from'), t('cashier.period_to'), t('cashier.cash_receipts'), t('cashier.expected'), t('cashier.counted'), t('cashier.variance'), t('cashier.closed_by'), t('common.notes')],
    rows: rows.map((c) => [c.id, stamp(c.period_start), stamp(c.period_end), c.invoice_count, Number(c.expected_cash), Number(c.counted_cash), Number(c.variance), c.closed_by_name || '', c.notes || '']),
  });
}));

router.get('/closings/:id(\\d+)', wrap(async (req, res) => {
  denyDoctorScope(req);
  const c = await svc.getClosing(req.ctx, req.params.id);
  res.page('pages/clinic/cashier/closing', {
    title: req.t('cashier.closing_slip', { n: c.id }), c, localTime: (d) => lib.localTime(d, req.ctx.timezone), printable: true, ...ASSETS,
  });
}));

module.exports = router;
module.exports.panelLocals = panelLocals;
module.exports.doneLocals = doneLocals;
