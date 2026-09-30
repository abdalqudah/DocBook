// Reception board (/app/front-desk): one clear flow per patient of today —
//   Expected → Arrived (check in) → With the doctor (send in) → To pay (the doctor finished) → Paid
// with one big action per patient, a doctor filter, live updates (public/js/live.js reloads the board when the
// clinic's agenda changes), a walk-in shortcut, the payment panel (the same one as the cash screen, opened in a
// dialog by public/js/cashx.js) and a "Print" menu per visit (receipt, invoice, prescription, certificates).
//   GET  /app/front-desk                 the board (?doctor=<id>, ?paid=<invoice id> shows the "paid" panel)
//   POST /app/front-desk/walk-in         new patient now: books the doctor's next free time today and checks in
//   POST /app/front-desk/:id/check-in    arrived (on=0 undoes)
//   POST /app/front-desk/:id/call-in     send in to the doctor (on=0: back to the waiting room)
//   POST /app/front-desk/:id/no-show     / restore
//   POST /app/front-desk/:id/checkout    the older quick checkout (kept for compatibility; the board now uses the payment panel)
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { z, validate, optionalString } = require('../../core/validate');
const appts = require('./appointments.service');
const cashier = require('./cashier.service');
const scheduling = require('./scheduling');
const { decimalsOf } = require('../../core/money');

const router = express.Router();
router.use(can('frontdesk.use'));

const errText = (req, e) => {
  for (const k of [`errors_cashx.${e.code}`, `errors.${e.code}`]) { const s = req.t(k); if (s !== k) return s; }
  return e.message;
};
const doctorFilter = (v) => (v === 'none' ? 'none' : Number(v) > 0 ? Number(v) : null);

async function renderBoard(req, res, extra = {}) {
  const { ctx } = req;
  const doctor = ctx.ownDoctorId ? null : doctorFilter(req.query.doctor);
  const [visits, doctors] = await Promise.all([cashier.today(ctx, { doctor }), cashier.doctorsWorking(ctx, ctx.today)]);
  const group = Object.fromEntries(cashier.FLOW.concat('missed').map((k) => [k, []]));
  visits.forEach((a) => group[a.state].push(a));
  group.arrived.sort((x, y) => new Date(x.arrived_at || 0) - new Date(y.arrived_at || 0));
  group.ready.sort((x, y) => new Date(x.doctor_finished_at || x.updated_at || 0) - new Date(y.doctor_finished_at || y.updated_at || 0));
  const collected = group.paid.reduce((s, a) => s + Number((a.invoice && a.invoice.amount) || a.amount_due || 0), 0);
  let done = null;
  if (Number(req.query.paid) && ctx.permissions.has('billing.view')) {
    done = await require('./cashier.web').doneLocals(req, res, Number(req.query.paid), 'front-desk'); // eslint-disable-line global-require
  }
  const onlineLinks = await require('../telehealth/web').linksFor(req, group.expected.concat(group.arrived)); // eslint-disable-line global-require
  res.page('pages/clinic/frontdesk/index', {
    title: req.t('frontdesk.title'), group, doctors, doctor, ownDoctor: Boolean(ctx.ownDoctorId), onlineLinks, collected, ...(done || {}),
    nowTime: scheduling.minutesToTime(scheduling.clinicNow(ctx.timezone).minutes), decimals: decimalsOf(ctx.currency),
    walkInDoctors: doctors.filter((d) => d.works && (!ctx.ownDoctorId || d.id === ctx.ownDoctorId)),
    pageScripts: ['/js/appointments.js', '/js/telehealth.js', '/js/cashx.js'], pageStyles: ['/css/appointments.css', '/css/cashx.css'], ...extra,
  });
}

router.get('/', wrap((req, res) => renderBoard(req, res)));

// Simple state toggles: errors (cancelled, not checked in…) come back as a flash message.
const safeReturn = (v) => (typeof v === 'string' && /^\/app\/[\w\-/?=&.%]*$/.test(v) && !v.startsWith('//') ? v : null);
const backTo = (req) => {
  const back = safeReturn(req.body.return_to); // e.g. the appointment drawer on the Appointments page
  if (back) return back;
  const d = doctorFilter(req.body.doctor_filter);
  return d ? `/app/front-desk?doctor=${d}` : '/app/front-desk';
};
const toggle = (fn, okKey) => wrap(async (req, res) => {
  try {
    await fn(req);
    flash(req, 'success', req.t(okKey));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 403) throw e;
    flash(req, 'error', errText(req, e));
  }
  res.redirect(backTo(req));
});

const on = (req) => req.body.on !== '0';
router.post('/:id(\\d+)/check-in', toggle((req) => appts.checkIn(req.ctx, Number(req.params.id), on(req)), 'frontdesk.saved'));
router.post('/:id(\\d+)/call-in', toggle((req) => appts.callIn(req.ctx, Number(req.params.id), on(req)), 'frontdesk.saved'));
router.post('/:id(\\d+)/no-show', toggle((req) => appts.setStatus(req.ctx, Number(req.params.id), 'no_show'), 'frontdesk.marked_no_show'));
router.post('/:id(\\d+)/restore', toggle((req) => appts.setStatus(req.ctx, Number(req.params.id), 'confirmed'), 'frontdesk.restored'));

// ---------------------------------------------------------------- walk-in: new patient now
const walkInSchema = z.object({
  patient_name: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(190),
  patient_phone: z.string({ required_error: 'Required.' }).trim().min(5, 'Required.').max(40),
  doctor_id: z.coerce.number({ invalid_type_error: 'Choose a valid value.' }).int().positive('Choose a valid value.'),
  notes: optionalString(500),
});

router.post('/walk-in', can('appointments.manage'), wrap(async (req, res) => {
  const { ctx } = req;
  try {
    const d = validate(walkInSchema, req.body);
    if (ctx.ownDoctorId && d.doctor_id !== ctx.ownDoctorId) throw new AppError('FORBIDDEN', 'Forbidden', 403);
    // The doctor's next free time today (the patient is here now: checked in straight away).
    const slots = await scheduling.availableSlots({ businessId: ctx.businessId, timezone: ctx.timezone, doctorId: d.doctor_id, date: ctx.today });
    if (!slots.length) throw new AppError('WALKIN_NO_TIME', 'No free time left today for this doctor.', 409);
    const id = await appts.book(ctx, { doctor_id: d.doctor_id, patient_name: d.patient_name, patient_phone: d.patient_phone, appointment_date: ctx.today, appointment_time: slots[0], status: 'confirmed', notes: d.notes }, { source: 'staff' });
    await appts.checkIn(ctx, id, true);
    flash(req, 'success', req.t('cashx.walkin_done', { name: d.patient_name, time: slots[0] }));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 403) throw e;
    const msg = e.code === 'VALIDATION_FAILED' ? req.t('cashx.walkin_invalid') : errText(req, e);
    flash(req, 'error', msg);
  }
  res.redirect('/app/front-desk');
}));

// The older quick checkout (amount + discount %) — kept so existing links and integrations keep working.
router.post('/:id(\\d+)/checkout', can('billing.manage'), form(async (req, res) => {
  const body = { ...req.body };
  if (body.payment_method !== 'insurance') delete body.insurance_provider_id;
  const invId = await appts.checkout(req.ctx, Number(req.params.id), body);
  flash(req, 'success', req.t('frontdesk.paid'));
  res.redirect(`/app/front-desk?paid=${invId}`);
}, (req, res, extra) => {
  flash(req, 'error', (extra.formError && extra.formError.message) || req.t('errors.VALIDATION_FAILED'));
  return res.redirect('/app/front-desk');
}));

module.exports = router;
module.exports.renderBoard = renderBoard;
