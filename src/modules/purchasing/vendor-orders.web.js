// Vendor portal: purchase orders sent to this vendor by clinics, mounted at /vendor/orders (behind requireVendor).
//   GET  /                    my orders (never drafts; nothing while the vendor is pending approval)
//   GET  /:id                 clinic contact, items and quantities (no costs, no patient data)
//   POST /:id/acknowledge     confirm the order (optional note) → the clinic is notified
//   POST /:id/note            leave / update a note for the clinic
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const svc = require('./purchasing.service');

const router = express.Router();
const BASE = '/vendor/orders';
const ASSETS = { pageStyles: ['/css/purchasing.css'] };
const LAYOUT = 'vendor';

function whenFn(req, timezone) {
  const f = new Intl.DateTimeFormat(req.locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone || 'UTC' });
  return (v) => { if (!v) return '—'; try { return f.format(new Date(v)); } catch { return '—'; } };
}

const act = (fn) => wrap(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!(err instanceof AppError) || ![409, 422].includes(err.status)) throw err;
    const own = req.t(`errors_purchasing.${err.code}`);
    flash(req, 'error', err.code === 'VALIDATION_FAILED' ? translateMessage(req.locale, Object.values(err.details || {})[0] || err.message) : (own !== `errors_purchasing.${err.code}` ? own : err.message));
    res.redirect(`${BASE}/${Number(req.params.id)}`);
  }
});

router.get('/', wrap(async (req, res) => {
  const { rows, counts, meta } = await svc.vendorList(req.vendor, req.query);
  res.page('pages/vendor/orders', {
    layout: LAYOUT, title: req.t('purchasing.vendor.title'), rows, counts, meta, pending: req.vendor.status !== 'active',
    when: (v, tz) => whenFn(req, tz)(v), navActive: 'orders', ...ASSETS,
  });
}));

router.get('/:id(\\d+)', wrap(async (req, res) => {
  const po = await svc.vendorGet(req.vendor, Number(req.params.id));
  res.page('pages/vendor/orders-show', {
    layout: LAYOUT, title: req.t('purchasing.po_no', { n: po.po_number }), po, when: whenFn(req, po.clinic_timezone), navActive: 'orders', ...ASSETS,
  });
}));

router.post('/:id(\\d+)/acknowledge', act(async (req, res) => {
  await svc.acknowledge(req.vendor, req.vendorCtx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('purchasing.vendor.acknowledged'));
  res.redirect(`${BASE}/${Number(req.params.id)}`);
}));

router.post('/:id(\\d+)/note', act(async (req, res) => {
  await svc.vendorNote(req.vendor, req.vendorCtx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('purchasing.vendor.note_saved'));
  res.redirect(`${BASE}/${Number(req.params.id)}`);
}));

module.exports = router;
