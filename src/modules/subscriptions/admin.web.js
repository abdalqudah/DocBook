// Platform admin: plans and clinic subscriptions (worker: subscriptions). Mounted inside src/modules/admin/web.js
// behind the platform-admin guard (req.ctx.businessId = null). Every change is audited in platform scope, and the
// clinic-level actions are also written to the clinic's own audit log.
//   /admin/plans                    plans list (+ create / edit / delete-or-retire)
//   /admin/plans/settings           the switch, trial length, grace period, bank / CliQ details shown to clinics
//   /admin/subscriptions            clinics with plan, status, period end, last payment; filters
//   /admin/subscriptions/:id        one clinic: extend trial, change plan, record a payment, comp, cancel, invoices
const express = require('express');
const knex = require('../../db/knex');
const { AppError, E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { translateMessage } = require('../../core/i18n');
const subs = require('./subscriptions.service');
const entitlements = require('./entitlements');

const router = express.Router();
const STYLES = ['/css/site.css', '/css/subscriptions.css'];
const SCRIPTS = ['/js/subscriptions.js'];
const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: STYLES, pageScripts: SCRIPTS, ...data });

const errText = (req, e) => {
  for (const k of [`errors_subscriptions.${e.code}`, `errors.${e.code}`]) { const s = req.t(k); if (s !== k) return s; }
  return e.message;
};
/** Runs an admin action; expected errors become a flash message (with the first field message) instead of an error page. */
const act = (fn) => wrap(async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    const first = e.details && Object.values(e.details)[0];
    flash(req, 'error', first ? `${errText(req, e)} ${translateMessage(req.locale, first)}` : errText(req, e));
    res.redirect(req.get('referer') && /\/admin\//.test(req.get('referer')) ? req.get('referer') : '/admin/subscriptions');
  }
});

// ---------------------------------------------------------------- plans
router.get('/plans', wrap(async (req, res) => {
  const [plans, cfg, usage] = await Promise.all([
    subs.listPlans(), subs.settings(),
    knex('clinic_subscriptions').whereNotNull('plan_id').groupBy('plan_id').select('plan_id').count({ n: '*' }),
  ]);
  const used = Object.fromEntries(usage.map((u) => [u.plan_id, Number(u.n)]));
  page(res, 'plans', { title: req.t('subscriptions_admin.plans_title'), plans, cfg, used, features: subs.FEATURES, tab: 'plans' });
}));

async function planForm(req, res, extra = {}) {
  const plan = req.params.id ? await subs.getPlan(req.params.id) : null;
  if (req.params.id && !plan) throw E.notFound('Plan');
  page(res, 'plans-form', { title: plan ? plan.name : req.t('subscriptions_admin.new_plan'), plan, features: subs.FEATURES, entitlements: entitlements.REGISTRY, entGroups: entitlements.GROUPS, tab: 'plans', errors: {}, formError: null, old: null, ...extra });
}
const planSave = (req, res) => subs.savePlan(req.ctx, req.params.id || null, req.body).then(() => {
  flash(req, 'success', req.t('subscriptions_admin.plan_saved'));
  res.redirect('/admin/plans');
}).catch((e) => {
  if (!(e instanceof AppError) || e.status !== 422) throw e;
  res.status(422);
  return planForm(req, res, {
    errors: Object.fromEntries(Object.entries(e.details || {}).map(([k, v]) => [k, translateMessage(req.locale, v)])),
    formError: { code: e.code, message: req.t('errors.VALIDATION_FAILED') }, old: req.body,
  });
});

router.get('/plans/new', wrap((req, res) => planForm(req, res)));
router.post('/plans/new', wrap(planSave));
router.get('/plans/:id(\\d+)', wrap((req, res) => planForm(req, res)));
router.post('/plans/:id(\\d+)', wrap(planSave));
router.post('/plans/:id(\\d+)/delete', act(async (req, res) => {
  const r = await subs.deletePlan(req.ctx, req.params.id);
  flash(req, 'success', req.t(r === 'deleted' ? 'subscriptions_admin.plan_deleted' : 'subscriptions_admin.plan_retired'));
  res.redirect('/admin/plans');
}));

// ---------------------------------------------------------------- platform settings
async function settingsPage(req, res, extra = {}) {
  const [cfg, plans] = await Promise.all([subs.settings(), subs.listPlans()]);
  page(res, 'plans-settings', { title: req.t('subscriptions_admin.settings_title'), cfg, plans, tab: 'settings', errors: {}, formError: null, old: null, ...extra });
}
router.get('/plans/settings', wrap((req, res) => settingsPage(req, res)));
router.post('/plans/settings', wrap(async (req, res) => {
  try {
    const before = await subs.settings();
    const d = await subs.saveSettings(req.ctx, req.body);
    flash(req, 'success', req.t(before.enabled !== d.enabled ? (d.enabled ? 'subscriptions_admin.enabled_done' : 'subscriptions_admin.disabled_done') : 'subscriptions_admin.settings_saved'));
    return res.redirect('/admin/plans/settings');
  } catch (e) {
    if (!(e instanceof AppError) || e.status !== 422) throw e;
    res.status(422);
    return settingsPage(req, res, {
      errors: Object.fromEntries(Object.entries(e.details || {}).map(([k, v]) => [k, translateMessage(req.locale, v)])),
      formError: { code: e.code, message: req.t('errors.VALIDATION_FAILED') }, old: req.body,
    });
  }
}));

// ---------------------------------------------------------------- clinic subscriptions
router.get('/subscriptions', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const status = [...subs.STATUSES, 'reported', 'none'].includes(req.query.status) ? req.query.status : '';
  const [data, cfg] = await Promise.all([subs.adminList({ q, status, page: req.query.page }), subs.settings()]);
  page(res, 'subscriptions', { title: req.t('subscriptions_admin.subs_title'), ...data, q, status, cfg, statuses: subs.STATUSES, tab: 'subscriptions' });
}));

router.get('/subscriptions/:id(\\d+)', wrap(async (req, res) => {
  const b = await knex('businesses').where({ id: req.params.id }).first('id', 'name', 'name_en', 'slug', 'email', 'phone', 'city', 'currency', 'timezone', 'status', 'created_at');
  if (!b) throw E.notFound('Clinic');
  const cfg = await subs.settings();
  const today = subs.todayOf(b);
  const sub = cfg.enabled ? await subs.ensure(b, today, cfg) : (await knex('clinic_subscriptions').where({ business_id: b.id }).first()) || null;
  const [plans, invoices, usage, owners] = await Promise.all([
    subs.listPlans(), subs.listInvoices(b.id, 100), subs.usage(b.id, today),
    knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').join('users as u', 'u.id', 'm.user_id').where({ 'm.business_id': b.id, 'r.key': 'owner', 'm.status': 'active' }).select('u.name', 'u.email'),
  ]);
  const plan = sub ? plans.find((p) => p.id === sub.plan_id) || null : null;
  const subView = sub ? { ...sub, trial_ends_at: sub.trial_ends_at && String(sub.trial_ends_at).slice(0, 10) } : null;
  page(res, 'subscriptions-show', {
    title: b.name, b, sub: subView, plan, plans, invoices, usage, owners, cfg, today, limits: subs.limitsOf(sub, plan), methods: subs.METHODS,
    readOnly: sub ? subs.isReadOnly(sub, today) : false, nextStart: sub ? subs.nextPeriodStart(sub, today) : today, tab: 'subscriptions',
  });
}));

const back = (req) => `/admin/subscriptions/${Number(req.params.id)}`;
router.post('/subscriptions/:id(\\d+)/extend-trial', act(async (req, res) => {
  const end = await subs.extendTrial(req.ctx, req.params.id, req.body);
  flash(req, 'success', req.t('subscriptions_admin.trial_extended', { date: end }));
  res.redirect(back(req));
}));
router.post('/subscriptions/:id(\\d+)/plan', act(async (req, res) => {
  await subs.changePlan(req.ctx, req.params.id, req.body);
  flash(req, 'success', req.t('subscriptions_admin.plan_changed'));
  res.redirect(back(req));
}));
router.post('/subscriptions/:id(\\d+)/payment', act(async (req, res) => {
  const r = await subs.recordPayment(req.ctx, req.params.id, req.body);
  flash(req, 'success', req.t('subscriptions_admin.payment_recorded', { date: r.end }));
  res.redirect(back(req));
}));
router.post('/subscriptions/:id(\\d+)/comp', act(async (req, res) => {
  await subs.comp(req.ctx, req.params.id, req.body);
  flash(req, 'success', req.t('subscriptions_admin.comped'));
  res.redirect(back(req));
}));
router.post('/subscriptions/:id(\\d+)/cancel', act(async (req, res) => {
  await subs.cancel(req.ctx, req.params.id);
  flash(req, 'success', req.t('subscriptions_admin.cancelled'));
  res.redirect(back(req));
}));
router.post('/subscriptions/:id(\\d+)/invoices/:inv(\\d+)/void', act(async (req, res) => {
  const inv = await subs.getInvoice(Number(req.params.id), req.params.inv);
  await subs.voidInvoice(req.ctx, inv.id);
  flash(req, 'success', req.t('subscriptions_admin.invoice_voided'));
  res.redirect(back(req));
}));

module.exports = router;
