// Clinic side: Settings → Subscription (/app/settings/subscription). Current plan and status, trial days left,
// usage against the plan's limits, choosing a plan (monthly / yearly), paying by bank transfer / CliQ / cash with a
// payment notice (the platform admin confirms it), by e-wallet, or by card through the platform's PayTabs profile
// (POST …/card → PayTabs; the return and callback come back through /pay/platform/…, outside the CSRF-protected
// app, and are verified with PayTabs before the invoice is marked paid). And the platform's invoices (printable).
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { render } = require('../settings/common');
const subs = require('./subscriptions.service');
const entitlements = require('./entitlements');
const branchPricing = require('./branch-pricing');

const router = express.Router();
const gate = can('settings.manage');
const BASE = '/app/settings/subscription';

async function page(req, res, extra = {}) {
  const cfg = await subs.settings();
  const st = cfg.enabled ? (req.subscription || await subs.state(req.business, req.ctx.today)) : null;
  const [plans, invoices, usage] = st ? await Promise.all([subs.listPlans({ activeOnly: true, publicOnly: true }), subs.listInvoices(req.ctx.businessId), subs.usage(req.ctx.businessId, req.ctx.today)]) : [[], [], null];
  const pending = invoices.find((i) => i.status === 'open' || i.status === 'reported') || null;
  // Each plan's branch limit and its price for 1 … 10 branches (the cards update with the number chosen).
  plans.forEach((pl) => { pl.maxBranches = entitlements.valueIn(pl.features, 'clinic.max_branches'); pl.bpTable = branchPricing.table(pl, pl.maxBranches, branchPricing.MAX_CHOICE); }); // every count that can be chosen
  const branchesNow = st ? Math.max(Number(st.sub.branches) || 1, usage ? usage.branches : 1) : 1;
  return render(req, res, 'subscription', 'subscription', {
    st, cfg, plans, invoices, usage, pending, features: subs.FEATURES, methods: subs.METHODS.filter((m) => m !== 'card'), payMethods: await require('../platformpay/platformpay.service').methods(), payResult: ['paid', 'pending', 'failed'].includes(req.query.pay) ? req.query.pay : null, // eslint-disable-line global-require
 branchesNow, priceFor: branchPricing.priceFor,
    cycle: ['monthly', 'yearly'].includes(req.query.cycle) ? req.query.cycle : (st && st.sub.billing_cycle) || 'monthly',
    pageStyles: ['/css/admin.css', '/css/subscriptions.css'], pageScripts: ['/js/admin.js', '/js/subscriptions.js'],
    errors: {}, formError: null, old: {}, ...extra,
  });
}

const enabledOnly = wrap(async (req, res, next) => ((await subs.settings()).enabled ? next() : res.redirect(BASE)));

router.get('/settings/subscription', gate, wrap((req, res) => page(req, res)));

router.post('/settings/subscription/choose', gate, enabledOnly, form(async (req, res) => {
  await subs.choosePlan(req.ctx, req.business, req.body);
  flash(req, 'success', req.t('subscriptions.chosen_done'));
  res.redirect(`${BASE}#pay`);
}, (req, res, extra) => page(req, res, extra)));

router.post('/settings/subscription/invoices/:id(\\d+)/notice', gate, enabledOnly, form(async (req, res) => {
  await subs.reportPayment(req.ctx, req.ctx.businessId, req.params.id, req.body);
  flash(req, 'success', req.t('subscriptions.notice_done'));
  res.redirect(`${BASE}#pay`);
}, (req, res, extra) => page(req, res, { ...extra, noticeFor: Number(req.params.id) })));

// Pay an open invoice by card (the platform's PayTabs page; the result comes back through /pay/platform/…).
router.post('/settings/subscription/invoices/:id(\\d+)/card', gate, enabledOnly, wrap(async (req, res) => {
  const ppay = require('../platformpay/platformpay.service'); // eslint-disable-line global-require
  try {
    const r = await ppay.start('clinic', { businessId: req.ctx.businessId, invoiceId: req.params.id, userId: req.ctx.userId, baseUrl: require('../../middleware/web').publicBase(req), lang: req.locale, customer: { name: req.business.name, email: req.user.email } }); // eslint-disable-line global-require
    return res.redirect(303, r.redirectUrl);
  } catch (e) {
    if (!e.code || (e.status >= 500 && e.code !== 'PAY_PROVIDER_ERROR' && e.code !== 'PAY_PROVIDER_UNREACHABLE')) throw e;
    flash(req, 'error', req.t(`ppay.err.${e.code}`) !== `ppay.err.${e.code}` ? req.t(`ppay.err.${e.code}`) : req.t('ppay.err.generic'));
    return res.redirect(`${BASE}#pay`);
  }
}));

router.get('/settings/subscription/invoices/:id(\\d+)', gate, wrap(async (req, res) => {
  const inv = await subs.getInvoice(req.ctx.businessId, req.params.id);
  const cfg = await subs.settings();
  res.page('pages/subscriptions/invoice', {
    title: `${req.t('subscriptions.invoice')} ${inv.number || inv.id}`, inv, cfg, printable: true, pageStyles: ['/css/subscriptions.css'],
  });
}));

module.exports = router;
