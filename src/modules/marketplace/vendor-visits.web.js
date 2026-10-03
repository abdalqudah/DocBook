// /vendor/visits — a rep (vendor user) books visits with doctors in the windows clinics reserve for reps, and follows
// the clinic's decision. Only ACTIVE vendors can book. Reps see the clinic's name/city/address, its doctors' names and
// the free rep times — never patients or patient appointments.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const { clinicNow, isDate } = require('../clinic/scheduling');
const market = require('./market.service');
const svc = require('./rep-visits.service');

const router = express.Router();

const LAYOUT = 'vendor';
const base = (req, extra) => ({
  layout: LAYOUT, noindex: true, pageStyles: ['/css/market.css'], pageScripts: ['/js/market.js'], activeNav: 'visits',
  L: (ar, en) => (req.locale === 'en' && en ? en : ar || en || ''), specialtyLabel: (k) => (k ? req.t(`specialties.${k}`) : ''),
  vendorActive: req.vendor.status === 'active', ...extra,
});
const errText = (req, e) => { for (const k of [`errors_market.${e.code}`, `vbill.err.${e.code}`]) { const tr = req.t(k); if (tr !== k) return tr; } return e.message; };

router.get('/', wrap(async (req, res) => {
  const visits = await svc.vendorVisits(req.vendor.id);
  visits.forEach((v) => { v.isPast = v.visit_date < clinicNow(v.timezone).date; });
  res.page('pages/vendor/visits', base(req, { title: req.t('rep_visits.vendor_side.title'), visits }));
}));

router.get('/new', wrap(async (req, res) => {
  const clinicId = Number(req.query.clinic) || 0;
  if (!clinicId) {
    const specialty = market.SPECIALTIES.includes(req.query.specialty) ? req.query.specialty : null;
    const clinics = req.vendor.status === 'active' ? await svc.bookableClinics({ q: req.query.q, specialty }) : [];
    return res.page('pages/vendor/visits-find', base(req, { title: req.t('rep_visits.vendor_side.find_title'), clinics, specialties: market.SPECIALTIES, specialty }));
  }
  return renderBook(req, res);
}));

async function renderBook(req, res, extra = {}) {
  if (req.vendor.status !== 'active') return res.redirect('/vendor/visits');
  const clinic = await svc.clinicForRep(req.query.clinic || req.body.business_id);
  if (!clinic) { flash(req, 'error', req.t('errors_market.NOT_FOUND')); return res.redirect('/vendor/visits/new'); }
  const src = { ...req.query, ...(extra.old || {}) };
  const today = clinicNow(clinic.timezone).date;
  let doctorId = src.doctor_id === undefined ? (clinic.doctors[0] ? String(clinic.doctors[0].id) : '') : String(src.doctor_id);
  if (doctorId && !clinic.doctors.some((d) => String(d.id) === doctorId)) doctorId = clinic.doctors[0] ? String(clinic.doctors[0].id) : '';
  if (!doctorId && !clinic.hasClinicWide && clinic.doctors[0]) doctorId = String(clinic.doctors[0].id);
  const date = isDate(src.visit_date || src.date) ? (src.visit_date || src.date) : '';
  let slots = null; let slotError = null;
  if (date && clinic.mode === 'slots') {
    try { slots = await svc.freeSlots({ businessId: clinic.id, doctorId: Number(doctorId) || null, date, timezone: clinic.timezone }); } catch (e) {
      if (!(e instanceof AppError)) throw e;
      slotError = errText(req, e); slots = [];
    }
  }
  const products = await knex('vendor_products').where({ vendor_id: req.vendor.id, is_active: true }).select('id', 'name', 'name_en').orderBy('name').limit(200);
  const maxDate = svc.addDays(today, svc.MAX_DAYS_AHEAD);
  return res.page('pages/vendor/visits-book', base(req, {
    title: req.t('rep_visits.vendor_side.book_title'), clinic, doctorId, date, slots, slotError, products, today, maxDate, ...extra,
  }));
}

router.post('/', wrap(async (req, res) => {
  try {
    const r = await svc.book(req.vendorCtx, req.vendor, req.body);
    flash(req, 'success', req.t(r.status === 'confirmed' ? 'rep_visits.vendor_side.confirmed_msg' : 'rep_visits.vendor_side.requested_msg'));
    return res.redirect('/vendor/visits');
  } catch (e) {
    if (!(e instanceof AppError) || ![403, 404, 409, 422].includes(e.status)) throw e;
    if (/^VENDOR_(LIMIT|SUB)_/.test(e.code)) { flash(req, 'error', errText(req, e)); return res.redirect('/vendor/billing'); }
    if (e.code === 'VENDOR_NOT_ACTIVE' || e.status === 404) { flash(req, 'error', errText(req, e)); return res.redirect('/vendor/visits'); }
    req.query.clinic = req.body.business_id;
    res.status(e.status);
    const { translateMessage } = require('../../core/i18n'); // eslint-disable-line global-require
    const errors = e.details && typeof e.details === 'object' ? Object.fromEntries(Object.entries(e.details).map(([k, v]) => [k, translateMessage(req.locale, v)])) : {};
    return renderBook(req, res, { old: req.body, errors, formError: { code: e.code, message: e.code === 'VALIDATION_FAILED' ? req.t('errors.VALIDATION_FAILED') : errText(req, e) } });
  }
}));

router.post('/:id(\\d+)/cancel', wrap(async (req, res) => {
  try {
    await svc.cancelByVendor(req.vendorCtx, req.params.id);
    flash(req, 'success', req.t('rep_visits.vendor_side.cancelled_msg'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', errText(req, e));
  }
  res.redirect('/vendor/visits');
}));

module.exports = router;
