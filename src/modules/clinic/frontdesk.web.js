// Front desk: today's board — expected → waiting room → with the doctor → checkout — with check-in,
// call-in, no-show and the checkout dialog that issues a numbered invoice (DocBook's net-amount rule).
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const appts = require('./appointments.service');
const clinical = require('./clinical.service');
const scheduling = require('./scheduling');
const { decimalsOf } = require('../../core/money');

const router = express.Router();
router.use(can('frontdesk.use'));

const errText = (req, e) => { const k = `errors.${e.code}`; const s = req.t(k); return s !== k ? s : e.message; };
const minutesSince = (ts) => (ts ? Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000)) : 0);

async function renderBoard(req, res, extra = {}) {
  const { ctx } = req;
  const rows = await appts.list(ctx, { from: ctx.today, to: ctx.today });
  const paid = (a) => a.payment_status === 'paid';
  const open = (a) => a.status === 'pending' || a.status === 'confirmed';
  const byTime = (x, y) => (x.appointment_time < y.appointment_time ? -1 : x.appointment_time > y.appointment_time ? 1 : 0);
  const board = {
    expected: rows.filter((a) => !paid(a) && !a.checked_in && open(a)).sort(byTime),
    waiting: rows.filter((a) => !paid(a) && a.checked_in && !a.with_doctor && open(a))
      .map((a) => ({ ...a, waited: minutesSince(a.arrived_at) }))
      .sort((x, y) => new Date(x.arrived_at || 0) - new Date(y.arrived_at || 0)),
    withDoctor: rows.filter((a) => !paid(a) && a.with_doctor && open(a)).map((a) => ({ ...a, inRoom: minutesSince(a.called_at) })).sort(byTime),
    toPay: rows.filter((a) => !paid(a) && a.status === 'completed').sort(byTime),
    done: rows.filter(paid).sort(byTime),
    missed: rows.filter((a) => !paid(a) && (a.status === 'no_show' || a.status === 'cancelled')).sort(byTime),
  };
  const collected = board.done.reduce((s, a) => s + Number(a.amount_due || 0), 0);
  const [insurance, invoices] = await Promise.all([
    ctx.permissions.has('billing.manage') ? clinical.activeInsurance(ctx) : [],
    board.done.length ? knex('invoices').where({ business_id: ctx.businessId }).whereIn('appointment_id', board.done.map((a) => a.id)).select('id', 'appointment_id', 'invoice_number') : [],
  ]);
  let justPaid = null;
  if (Number(req.query.paid)) {
    justPaid = await knex('invoices').where({ business_id: ctx.businessId, id: Number(req.query.paid) }).first('id', 'invoice_number', 'patient_name', 'amount');
  }
  res.page('pages/clinic/frontdesk/index', {
    title: req.t('frontdesk.title'), board, collected, insurance, methods: appts.PAYMENT_METHODS, invoiceFor: Object.fromEntries(invoices.map((i) => [i.appointment_id, i])),
    justPaid, nowTime: scheduling.minutesToTime(scheduling.clinicNow(ctx.timezone).minutes), decimals: decimalsOf(ctx.currency), pageScripts: ['/js/appointments.js'], pageStyles: ['/css/appointments.css'], ...extra,
  });
}

router.get('/', wrap((req, res) => renderBoard(req, res)));

// Simple state toggles: errors (cancelled, not checked in…) come back as a flash message.
const toggle = (fn, okKey) => wrap(async (req, res) => {
  try {
    await fn(req);
    flash(req, 'success', req.t(okKey));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 403) throw e;
    flash(req, 'error', errText(req, e));
  }
  res.redirect('/app/front-desk');
});

const on = (req) => req.body.on !== '0';
router.post('/:id(\\d+)/check-in', toggle((req) => appts.checkIn(req.ctx, Number(req.params.id), on(req)), 'frontdesk.saved'));
router.post('/:id(\\d+)/call-in', toggle((req) => appts.callIn(req.ctx, Number(req.params.id), on(req)), 'frontdesk.saved'));
router.post('/:id(\\d+)/no-show', toggle((req) => appts.setStatus(req.ctx, Number(req.params.id), 'no_show'), 'frontdesk.marked_no_show'));
router.post('/:id(\\d+)/restore', toggle((req) => appts.setStatus(req.ctx, Number(req.params.id), 'confirmed'), 'frontdesk.restored'));

router.post('/:id(\\d+)/checkout', can('billing.manage'), form(async (req, res) => {
  const body = { ...req.body };
  if (body.payment_method !== 'insurance') delete body.insurance_provider_id;
  const invId = await appts.checkout(req.ctx, Number(req.params.id), body);
  flash(req, 'success', req.t('frontdesk.paid'));
  res.redirect(`/app/front-desk?paid=${invId}`);
}, (req, res, extra) => {
  if (extra.formError && extra.formError.code !== 'VALIDATION_FAILED') {
    flash(req, 'error', extra.formError.message);
    return res.redirect('/app/front-desk');
  }
  return renderBoard(req, res, { ...extra, openDialog: 'checkout-dialog', formAction: `/app/front-desk/${req.params.id}/checkout` });
}));

module.exports = router;
