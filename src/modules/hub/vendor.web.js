// A rep on the platform books a visit at a linked installation's clinic — live: its doctors and free times are read
// from the clinic's own system, the booking is made there, and its decision comes back (hub.service).
const express = require('express');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const hub = require('./hub.service');

const router = express.Router();
const L = (req) => (ar, en) => (req.locale === 'en' && en ? en : ar || en || '');
const vctx = (req) => ({ vendorId: req.vendor.id, userId: req.user && req.user.id, userName: req.user && req.user.name });

async function render(req, res, extra = {}) {
  const { link, clinic } = await hub.repClinic(req.params.link);
  const doctorId = Number(req.query.doctor_id || (extra.old && extra.old.doctor_id)) || null;
  const date = String(req.query.date || (extra.old && extra.old.visit_date) || '');
  let slots = null;
  if (clinic.mode === 'slots' && /^\d{4}-\d{2}-\d{2}$/.test(date) && (doctorId || clinic.hasClinicWide)) slots = await hub.repSlots(link.id, doctorId, date).catch(() => []);
  return res.page('pages/vendor/hub-book', {
    layout: 'vendor', noindex: true, pageStyles: ['/css/market.css'], activeNav: 'visits', title: req.t('rep_visits.vendor_side.book'),
    link, clinic, doctorId, date, slots, L: L(req), specialtyLabel: (k) => (k ? req.t(`specialties.${k}`) : ''), vendorActive: req.vendor.status === 'active', errors: {}, old: {}, ...extra,
  });
}
router.get('/:link(\\d+)', wrap(async (req, res) => {
  try { return await render(req, res); } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', e.message);
    return res.redirect('/vendor/visits/new');
  }
}));
router.post('/:link(\\d+)', wrap(async (req, res) => {
  try {
    const r = await hub.repBook(vctx(req), req.vendor, req.params.link, { doctor_id: req.body.doctor_id, visit_date: req.body.visit_date, visit_time: req.body.visit_time, purpose: req.body.purpose });
    flash(req, 'success', req.t(r.status === 'confirmed' ? 'rep_visits.vendor_side.confirmed_msg' : 'rep_visits.vendor_side.requested_msg'));
    return res.redirect('/vendor/visits');
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    res.status(422);
    return render(req, res, { formError: { message: e.message }, errors: e.details || {}, old: req.body });
  }
}));
router.post('/cancel/:id(\\d+)', wrap(async (req, res) => {
  try { await hub.repCancel(vctx(req), req.params.id); flash(req, 'success', req.t('rep_visits.vendor_side.cancelled_msg')); } catch (e) { flash(req, 'error', e.message); }
  res.redirect('/vendor/visits');
}));
module.exports = router;
