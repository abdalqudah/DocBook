// /app/rep-visits — the clinic side of rep visits: requests, upcoming and past visits, and (vendors.manage) the
// booking settings with the weekly windows reserved for reps. Doctor-scoped logins only see their own visits.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { clinicNow, DAY_KEYS } = require('../clinic/scheduling');
const svc = require('./rep-visits.service');

const router = express.Router();
router.use(can('vendors.view'));
router.use((req, res, next) => { req.ctx.today = req.ctx.today || clinicNow(req.ctx.timezone).date; next(); });

const localize = (fn) => async (req, res, next) => {
  try { return await fn(req, res, next); } catch (e) {
    if (e instanceof AppError) { const k = `errors_market.${e.code}`; const tr = req.t(k); if (tr !== k) e.message = tr; }
    throw e;
  }
};

const TABS = ['requests', 'upcoming', 'past', 'settings'];

async function render(req, res, extra = {}) {
  const manage = req.ctx.permissions.has('vendors.manage');
  let tab = TABS.includes(req.query.tab) ? req.query.tab : 'requests';
  if (tab === 'settings' && !manage) tab = 'requests';
  if (extra.openDialog === 'window-dialog') tab = 'settings';
  const settings = await svc.settings(req.ctx.businessId);
  const data = {
    title: req.t('nav.rep_visits'), tab, settings, manage, counts: await svc.counts(req.ctx, req.ctx.today), today: req.ctx.today,
    pageScripts: ['/js/market.js'], pageStyles: ['/css/market.css'], days: DAY_KEYS, ownScope: Boolean(req.ctx.ownDoctorId), myDoctorId: req.ctx.doctorId,
    L: (ar, en) => (req.locale === 'en' && en ? en : ar || en || ''), ...extra,
  };
  if (tab === 'settings') {
    data.windows = await svc.windows(req.ctx.businessId);
    data.doctors = await knex('doctors').where({ business_id: req.ctx.businessId, is_active: true }).select('id', 'full_name', 'full_name_en', 'color').orderBy('sort_order').orderBy('id');
  } else {
    data.visits = await svc.clinicVisits(req.ctx, { tab, today: req.ctx.today });
  }
  res.page('pages/rep-visits/index', data);
}

router.get('/', wrap((req, res) => render(req, res)));

router.post('/settings', can('vendors.manage'), wrap(async (req, res) => {
  await svc.saveSettings(req.ctx, req.body);
  flash(req, 'success', req.t('rep_visits.settings_saved'));
  res.redirect('/app/rep-visits?tab=settings');
}));

const rerenderWindow = (req, res, extra) => render(req, res, { ...extra, openDialog: 'window-dialog', formAction: req.originalUrl });
router.post('/windows', can('vendors.manage'), form(localize(async (req, res) => {
  await svc.saveWindow(req.ctx, null, req.body);
  flash(req, 'success', req.t('rep_visits.window_saved'));
  res.redirect('/app/rep-visits?tab=settings');
}), rerenderWindow));
router.post('/windows/:id(\\d+)', can('vendors.manage'), form(localize(async (req, res) => {
  await svc.saveWindow(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('rep_visits.window_saved'));
  res.redirect('/app/rep-visits?tab=settings');
}), rerenderWindow));
router.post('/windows/:id(\\d+)/delete', can('vendors.manage'), wrap(async (req, res) => {
  await svc.removeWindow(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('rep_visits.window_deleted'));
  res.redirect('/app/rep-visits?tab=settings');
}));

// Decisions: vendors.manage, or the doctor the visit is with (checked in the service).
const MSG = { confirmed: 'rep_visits.confirmed_msg', declined: 'rep_visits.declined_msg', done: 'rep_visits.done_msg', cancelled: 'rep_visits.cancelled_msg' };
router.post('/:id(\\d+)/:action(confirm|decline|done|cancel)', wrap(async (req, res) => {
  const back = TABS.includes(req.body._tab) ? req.body._tab : 'requests';
  try {
    const status = await svc.decide(req.ctx, req.params.id, req.params.action, req.body.note);
    flash(req, 'success', req.t(MSG[status]));
  } catch (e) {
    if (!(e instanceof AppError) || e.status === 403 || e.status === 404) throw e;
    const k = `errors_market.${e.code}`; const tr = req.t(k);
    flash(req, 'error', tr !== k ? tr : e.message);
  }
  res.redirect(`/app/rep-visits?tab=${back}`);
}));

module.exports = router;
