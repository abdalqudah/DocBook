// Platform admin → Payment methods (/admin/payments): bank transfer (IBAN), CliQ, e-wallet and PayTabs (cards) used
// by clinics paying their subscription and reps paying plans and ads. Mounted after the admin guard.
const express = require('express');
const { wrap, flash, form } = require('../../routes/helpers');
const ppay = require('./platformpay.service');
const knex = require('../../db/knex');

const router = express.Router();
const render = async (req, res, extra = {}) => {
  const [v, recent] = await Promise.all([ppay.adminView(), knex('platform_payments').orderBy('id', 'desc').limit(20)]);
  res.page('pages/admin/payments', { layout: 'admin', title: req.t('ppay.admin.title'), v, regions: ppay.REGIONS, recent, errors: {}, ...extra });
};
router.get('/', wrap((req, res) => render(req, res)));
router.post('/', form(async (req, res) => {
  await ppay.save(req.ctx, req.body);
  flash(req, 'success', req.t('ppay.admin.saved'));
  res.redirect('/admin/payments');
}, render));
router.post('/test', wrap(async (req, res) => {
  let r;
  try { r = await ppay.testConnection(); } catch (e) { r = { ok: false, message: e.message }; }
  flash(req, r.ok ? 'success' : 'error', r.ok ? req.t('ppay.admin.test_ok') : req.t('ppay.admin.test_fail', { message: r.message || '' }));
  res.redirect('/admin/payments');
}));

module.exports = router;
