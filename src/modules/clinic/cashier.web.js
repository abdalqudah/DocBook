// Cashier (POS-style patient payments) and cash-drawer closings — DocBook's cash register, for clinic visits.
//   GET  /app/cashier                 queue of visits waiting to pay + the bill of ?visit=<appointmentId>   (billing.manage)
//   POST /app/cashier/:id/pay         take the payment (server recomputes every figure)                     (billing.manage)
//   GET  /app/cashier/closings        open drawer period + closing history                                 (billing.view)
//   POST /app/cashier/closings        close the drawer (period end stamped by the server)                  (billing.manage)
//   GET  /app/cashier/closings/export history export                                                       (data.export)
//   GET  /app/cashier/closings/:id    closing slip (printable)                                             (billing.view)
const express = require('express');
const knex = require('../../db/knex');
const exporter = require('../../core/exporter');
const { AppError, E } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const { decimalsOf } = require('../../core/money');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const svc = require('./cashier.service');
const lib = require('./records.lib');

const router = express.Router();
router.use(canAny('billing.view', 'billing.manage'));

const ASSETS = { pageScripts: ['/js/cashier.js'], pageStyles: ['/css/cashier.css'] };
const EXPECTED_ERRORS = [404, 409, 422];

/** Human text for an AppError: this area's codes first, then the shared table, then the English message. */
function errorText(req, err) {
  for (const key of [`errors_cashier.${err.code}`, `errors.${err.code}`]) { const s = req.t(key); if (s !== key) return s; }
  return err.message;
}
function fieldErrors(req, err) {
  if (!err.details || typeof err.details !== 'object') return {};
  return Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k, v === 'CASH_SHORT' ? req.t('errors_cashier.CASH_SHORT') : translateMessage(req.locale, v)]));
}

// ---------------------------------------------------------------- cashier screen
async function renderScreen(req, res, extra = {}) {
  const { ctx } = req;
  const visitId = Number(req.query.visit || extra.visitId) || null;
  const [queue, results, receipts, totals, period] = await Promise.all([
    svc.queue(ctx), svc.search(ctx, req.query.q), svc.recentReceipts(ctx), svc.todayTotals(ctx),
    ctx.ownDoctorId ? null : svc.openPeriod(ctx),
  ]);
  let bill = null;
  if (visitId) {
    try {
      const a = await svc.visit(ctx, visitId);
      const [services, insurance] = await Promise.all([svc.servicesFor(ctx, a.doctor_id), svc.activeInsurance(ctx)]);
      const old = extra.old || null;
      let lines = svc.defaultLines(a);
      if (old && old.items) lines = (Array.isArray(old.items) ? old.items : Object.values(old.items)).map((l) => ({ name: l.name, service_id: l.service_id || null, qty: l.qty, unit_price: l.unit_price }));
      const inv = a.payment_status === 'paid' ? await knex('invoices').where({ business_id: ctx.businessId, appointment_id: a.id }).orderBy('id', 'desc').first('id') : null;
      bill = { a, lines, services, insurance, old, invoiceId: inv ? inv.id : null };
    } catch (e) {
      if (!(e instanceof AppError) || e.status !== 404) throw e;
      flash(req, 'error', req.t('cashier.visit_not_found'));
    }
  }
  let justPaid = null;
  if (Number(req.query.paid)) justPaid = receipts.find((r) => r.id === Number(req.query.paid)) || null;
  res.status(extra.status || 200);
  return res.page('pages/clinic/cashier/index', {
    title: req.t('cashier.title'), queue, results, receipts, totals, period, bill, justPaid, visitId,
    searchTerm: String(req.query.q || '').trim().slice(0, 80), methods: svc.PAYMENT_METHODS, decimals: decimalsOf(ctx.currency),
    localTime: (d) => lib.localTime(d, ctx.timezone), errors: extra.errors || {}, formError: extra.formError || null, ...ASSETS,
  });
}

router.get('/', wrap(async (req, res) => {
  if (!req.ctx.permissions.has('billing.manage')) return res.redirect('/app/cashier/closings');
  return renderScreen(req, res);
}));

router.post('/:id(\\d+)/pay', can('billing.manage'), wrap(async (req, res) => {
  const apptId = Number(req.params.id);
  try {
    const r = await svc.pay(req.ctx, apptId, req.body);
    const change = r.change ? req.t('cashier.change_toast', { v: res.locals.fmt.money(r.change) }) : '';
    flash(req, 'success', [req.t('cashier.paid_toast', { n: r.number, v: res.locals.fmt.money(r.total) }), change].filter(Boolean).join(' · '));
    if (req.body.intent === 'print') return res.redirect(`/app/billing/${r.id}?print=1&autoprint=1`);
    return res.redirect(`/app/cashier?paid=${r.id}`);
  } catch (err) {
    if (!(err instanceof AppError) || !EXPECTED_ERRORS.includes(err.status)) throw err;
    if (err.code === 'ALREADY_PAID' || err.status === 404) { flash(req, 'error', errorText(req, err)); return res.redirect('/app/cashier'); }
    req.query.visit = String(apptId);
    return renderScreen(req, res, { status: err.status, old: req.body, errors: fieldErrors(req, err), formError: { code: err.code, message: errorText(req, err) } });
  }
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
