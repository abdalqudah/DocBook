// Patient pages reached from messages (public, noindex, no sign-in — the secret token is the only credential):
//   /r/<token>                 the appointment: confirm, cancel (with reason, clinic cut-off), reschedule, calendar
//   /r/<token>/reschedule      free times of the same doctor/service, moved under the slot lock
//   /r/<token>/calendar.ics    calendar file
//   /r/<token>/stop            opt out of automated messages (and back in)
//   /review/<token>            verified review after a visit (see src/modules/reviews/public.web.js)
// An action link stops working once the appointment is over. Nothing about other patients is reachable here.
const { siteLook } = require('../site/portal.web');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const { wrap } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const { publicBase } = require('../../middleware/web');
const businesses = require('../businesses/business.service');
const scheduling = require('../clinic/scheduling');
const msg = require('./messaging.service');
const { clinicView, noStore, notFound, errText } = require('./pages');

const router = express.Router();
const pageLimiter = rateLimit({ windowMs: 10 * 60_000, limit: config.isTest ? 5000 : 120, standardHeaders: true, legacyHeaders: false });
const postLimiter = rateLimit({ windowMs: 10 * 60_000, limit: config.isTest ? 5000 : 30, standardHeaders: true, legacyHeaders: false });
const RESCHEDULE_DAYS = 21;

/** Appointment + clinic + settings for :token, or null (malformed, unknown, clinic suspended, or expired). */
// Which clinic's database has this appointment link (src/db/tenant.js).
router.param('token', require('../../db/tenant').byParam('msg', (token) => msg.byToken(token, 'action')));

async function load(req, { allowExpired = false } = {}) {
  const a = await msg.byToken(req.params.token, 'action');
  if (!a) return null;
  const b = await businesses.get(a.business_id);
  if (!b || b.status !== 'active') return null;
  const cfg = await msg.getConfig(b.id);
  const st = msg.actionState(a, b, cfg);
  if (st.expired && !allowExpired) return null;
  return { a, clinic: clinicView(req, b), cfg, st };
}

const meta = (req, via = 'link') => ({ ip: req.ip, userAgent: req.get('user-agent'), locale: req.locale, base: publicBase(req), via });

async function view(req, res, found, extra = {}) {
  const { a, clinic, cfg, st } = found;
  const en = req.locale === 'en';
  res.locals.currency = clinic.currency;
  return res.page(extra.view || 'pages/engage/appointment', {
    layout: 'public', title: req.t('messaging.page_title'), pageTitle: `${req.t('messaging.page_title')} · ${clinic.displayName}`, noindex: true, hideBookCta: true,
    clinic, a, st, cfg, token: req.params.token, done: ['confirmed', 'cancelled', 'rescheduled', 'already', 'stopped', 'started'].includes(req.query.done) ? req.query.done : null,
    doctor: (en && a.doctor_name_en) || a.doctor_name, doctorSpec: (en ? a.doctor_spec_en || a.doctor_spec : a.doctor_spec || a.doctor_spec_en) || '',
    service: (en && a.service_name_en) || a.service_name, length: msg.lengthOf(a), error: null,
    ...(await siteLook(req, res, clinic, ['/css/engage.css'])), pageScripts: ['/js/engage.js'], ...extra,
  });
}

router.get('/r/:token', pageLimiter, wrap(async (req, res) => {
  noStore(res);
  const found = await load(req);
  if (!found) return notFound(req, res);
  return view(req, res, found);
}));

router.post('/r/:token/confirm', postLimiter, wrap(async (req, res) => {
  noStore(res);
  const found = await load(req);
  if (!found) return notFound(req, res);
  try {
    const r = await msg.patientConfirm(found.a, found.clinic, found.cfg, meta(req));
    return res.redirect(303, `/r/${req.params.token}?done=${r === 'already' ? 'already' : 'confirmed'}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return view(req, res.status(err.status), found, { error: errText(req, err) });
  }
}));

router.post('/r/:token/cancel', postLimiter, wrap(async (req, res) => {
  noStore(res);
  const found = await load(req);
  if (!found) return notFound(req, res);
  try {
    await msg.patientCancel(found.a, found.clinic, found.cfg, req.body.reason, meta(req));
    return res.redirect(303, `/r/${req.params.token}?done=cancelled`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return view(req, res.status(err.status), found, { error: errText(req, err) });
  }
}));

async function rescheduleView(req, res, found, extra = {}) {
  const { a, clinic } = found;
  const today = scheduling.clinicNow(clinic.timezone).date;
  const days = [];
  for (let i = 0; i < RESCHEDULE_DAYS; i += 1) { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); days.push(d.toISOString().slice(0, 10)); }
  const date = days.includes(String(req.query.date || req.body.date || '')) ? String(req.query.date || req.body.date) : (days.includes(a.appointment_date) ? a.appointment_date : today);
  let slots = [];
  if (found.st.canReschedule) {
    try { slots = await msg.rescheduleSlots(a, clinic, date); } catch (err) { if (!(err instanceof AppError)) throw err; slots = []; }
    if (date === a.appointment_date) slots = slots.filter((s) => s !== a.appointment_time);
  }
  return view(req, res, found, { view: 'pages/engage/reschedule', days, date, slots, ...extra });
}

router.get('/r/:token/reschedule', pageLimiter, wrap(async (req, res) => {
  noStore(res);
  const found = await load(req);
  if (!found) return notFound(req, res);
  return rescheduleView(req, res, found);
}));

router.post('/r/:token/reschedule', postLimiter, wrap(async (req, res) => {
  noStore(res);
  const found = await load(req);
  if (!found) return notFound(req, res);
  try {
    await msg.patientReschedule(found.a, found.clinic, found.cfg, String(req.body.date || ''), String(req.body.time || ''), meta(req));
    return res.redirect(303, `/r/${req.params.token}?done=rescheduled`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    res.status(err.status);
    return rescheduleView(req, res, found, { error: err.code === 'VALIDATION_FAILED' ? req.t('messaging.pick_time') : errText(req, err) });
  }
}));

router.get('/r/:token/calendar.ics', pageLimiter, wrap(async (req, res) => {
  const found = await load(req);
  if (!found) return res.status(404).end();
  noStore(res);
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="appointment-${found.a.appointment_date}.ics"` });
  return res.send(msg.ics(found.a, found.clinic, req.locale, msg.actionUrl(publicBase(req), req.params.token)));
}));

// Opt-out works a little longer than the other actions (allowExpired): a patient may ask after the visit.
router.get('/r/:token/stop', pageLimiter, wrap(async (req, res) => {
  noStore(res);
  const found = await load(req, { allowExpired: true });
  if (!found) return notFound(req, res);
  const optedOut = await msg.isOptedOut(found.a, msg.dialFor(found.cfg, found.clinic));
  return view(req, res, found, { view: 'pages/engage/stop', optedOut, action: `/r/${req.params.token}/stop` });
}));

router.post('/r/:token/stop', postLimiter, wrap(async (req, res) => {
  noStore(res);
  const found = await load(req, { allowExpired: true });
  if (!found) return notFound(req, res);
  const out = req.body.out !== '0';
  await msg.setOptOut(found.a.business_id, { patientId: found.a.patient_id, phone: found.a.patient_phone, dial: msg.dialFor(found.cfg, found.clinic) }, out, { ...meta(req), via: 'link' });
  return res.redirect(303, `/r/${req.params.token}/stop?done=${out ? 'stopped' : 'started'}`);
}));

router.use('/review', require('../reviews/public.web'));

module.exports = router;
