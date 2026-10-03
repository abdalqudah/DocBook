// Platform admin → Reps billing (/admin/vendor-billing): turn limits on/off, trial length, ad price, plans,
// vendors' subscriptions (extend trial), invoices (confirm a transfer) and ad review. Mounted after the admin guard.
const express = require('express');
const { wrap, flash, form } = require('../../routes/helpers');
const { CURRENCIES } = require('../../core/money');
const billing = require('./billing.service');

const router = express.Router();
const TABS = ['invoices', 'ads', 'vendors', 'plans', 'settings'];

const render = async (req, res, extra = {}) => {
  const tab = TABS.includes(extra.tab || req.query.tab) ? (extra.tab || req.query.tab) : 'invoices';
  const istatus = ['open', 'reported', 'paid', 'void'].includes(req.query.status) ? req.query.status : '';
  const [s, plans, invoices, ads, vendors] = await Promise.all([billing.settings(), billing.plans(), billing.adminInvoices(istatus), billing.adminAds(), billing.adminVendors()]);
  const editPlan = req.query.plan ? plans.find((p) => p.id === Number(req.query.plan)) || null : null;
  res.page('pages/admin/vendor-billing', {
    layout: 'admin', pageStyles: ['/css/vbill.css'], title: req.t('vbill.admin.title'), tab, tabs: TABS, s, plans, invoices, ads, vendors, istatus, editPlan,
    currencies: CURRENCIES, reported: invoices.filter((i) => i.status === 'reported').length, errors: {}, ...extra,
  });
};
router.get('/', wrap((req, res) => render(req, res)));

router.post('/settings', form(async (req, res) => {
  await billing.saveSettings(req.ctx, req.body);
  flash(req, 'success', req.t('vbill.admin.saved'));
  res.redirect('/admin/vendor-billing?tab=settings');
}, (req, res, extra) => render(req, res, { ...extra, tab: 'settings' })));

router.post('/plans', form(async (req, res) => {
  await billing.savePlan(req.ctx, Number(req.body.id) || null, req.body);
  flash(req, 'success', req.t('vbill.admin.saved'));
  res.redirect('/admin/vendor-billing?tab=plans');
}, (req, res, extra) => render(req, res, { ...extra, tab: 'plans' })));

router.post('/invoices/:id(\\d+)/confirm', wrap(async (req, res) => {
  await billing.confirmPayment(req.ctx, req.params.id, { method: req.body.method, reference: req.body.reference });
  flash(req, 'success', req.t('vbill.admin.confirmed'));
  res.redirect('/admin/vendor-billing?tab=invoices');
}));
router.post('/invoices/:id(\\d+)/void', wrap(async (req, res) => {
  await billing.voidInvoice(req.ctx, req.params.id);
  flash(req, 'success', req.t('vbill.admin.voided'));
  res.redirect('/admin/vendor-billing?tab=invoices');
}));
router.post('/vendors/:id(\\d+)/trial', wrap(async (req, res) => {
  await billing.extendTrial(req.ctx, Number(req.params.id), req.body.days);
  flash(req, 'success', req.t('vbill.admin.trial_extended'));
  res.redirect('/admin/vendor-billing?tab=vendors');
}));
router.post('/ads/:id(\\d+)/:action(approve|reject)', wrap(async (req, res) => {
  await billing.moderateAd(req.ctx, req.params.id, req.params.action, req.body.note);
  flash(req, 'success', req.t('vbill.admin.saved'));
  res.redirect('/admin/vendor-billing?tab=ads');
}));

module.exports = router;
