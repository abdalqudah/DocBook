// Medical centre pages (/app/center):
//   GET  /                 the centre: its practices, invitations, this practice's sharing choice (settings.manage)
//   POST /create · /rename · /invite · /invites/:id/delete · /share-cash · /leave · /members/:bid/remove
//   GET  /desk             the shared reception: today's visits of every practice (frontdesk.use)
//   GET  /desk/data        the same as JSON (live refresh)
//   POST /desk/:bid/:id/:action   check-in | uncheck | call-in | uncall a visit of any practice of the centre
const express = require('express');
const knex = require('../../db/knex');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const svc = require('./center.service');
const shared = require('./shared.service');
const cashier = require('../clinic/cashier.service');
const appts = require('../clinic/appointments.service');

const router = express.Router();
const errText = (req, err) => { for (const k of [`center.err.${err.code}`, `errors.${err.code}`]) { const s = req.t(k); if (s !== k) return s; } return err.message; };
const act = (fn, back = () => '/app/center') => wrap(async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500) throw err;
    const { translateMessage } = require('../../core/i18n'); // eslint-disable-line global-require
    flash(req, 'error', err.code === 'VALIDATION_FAILED' ? (Object.values(err.details || {}).map((m) => translateMessage(req.locale, m))[0] || req.t('errors.VALIDATION_FAILED')) : errText(req, err));
  }
  if (!res.headersSent) res.redirect(back(req));
});

// ---------------------------------------------------------------- the centre
const TABS = ['practices', 'staff', 'costs', 'settings'];
// The centre's administration account opens each part at its own address (its menu); a practice keeps ?tab=.
const PATHS = { practices: 'doctors', staff: 'staff', costs: 'expenses', settings: 'settings' };
const TAB_OF = { doctors: 'practices', staff: 'staff', expenses: 'costs', settings: 'settings' };
async function renderCenter(req, res, wanted) {
  const center = await svc.ofBusiness(req.ctx.businessId);
  const founder = svc.isFounder(center, req.ctx.businessId);
  const tab = founder && TABS.includes(wanted) ? wanted : 'practices';
  const [members, invites] = center ? await Promise.all([svc.members(center.id), svc.pendingInvites(center.id)]) : [[], []];
  const extra = {};
  if (center && founder && tab === 'staff') extra.staff = await shared.listStaff(center.id);
  if (center && founder && tab === 'costs') {
    const [expenses, balances, staff] = await Promise.all([shared.expenses(center.id), shared.balances(center.id), shared.listStaff(center.id)]);
    Object.assign(extra, { expenses, balances: Object.fromEntries(balances.map((b) => [b.business_id, { owed: Number(b.owed), paid: Number(b.paid) }])), salaryTotal: staff.filter((x) => x.is_active).reduce((t, x) => t + Number(x.salary_monthly), 0) });
  }
  res.page('pages/center/index', {
    title: req.ctx.centerAdmin ? req.t(`center.tab.${tab}`) : req.t('center.title'), center, members, invites, founder, tab, lastLink: req.session.centerLink || null, lastLogin: req.session.centerLogin || null,
    adminAccount: Boolean(req.ctx.centerAdmin), tabHref: (k) => (req.ctx.centerAdmin ? `/app/center/${PATHS[k]}` : `/app/center?tab=${k}`),
    categories: require('../expenses/expense.service').SYSTEM_CATEGORIES.filter((k) => k !== 'center_share'), // eslint-disable-line global-require
    thisMonth: req.ctx.today.slice(0, 7), pageStyles: ['/css/admin.css', '/css/center.css'], pageScripts: ['/js/center.js'], ...extra,
  });
  delete req.session.centerLink; delete req.session.centerLogin;
}

/** The centre's home (administration account): where things stand, and the next step to take. */
async function renderHome(req, res) {
  const center = await svc.ofBusiness(req.ctx.businessId);
  if (!center) return renderCenter(req, res, 'practices');
  const members = await svc.members(center.id);
  const ids = members.map((m) => m.id);
  const [staff, expenses, balances, visits] = await Promise.all([
    shared.listStaff(center.id), shared.expenses(center.id, { limit: 1 }), shared.balances(center.id),
    ids.length ? knex('appointments').whereIn('business_id', ids).where({ appointment_date: req.ctx.today }).whereNotIn('status', ['cancelled']).whereNot('appointment_type', 'blocked').count({ n: '*' }).then(([r]) => Number(r.n)) : 0,
  ]);
  const owed = balances.reduce((t, b) => t + Number(b.owed), 0);
  return res.page('pages/center/home', {
    title: (req.locale === 'en' && center.name_en) || center.name, center, members, staffCount: staff.filter((x) => x.is_active).length,
    hasExpenses: expenses.length > 0, owed, visits, sharing: members.filter((m) => m.center_share_cash).length, pageStyles: ['/css/center.css'],
  });
}

router.get('/', can('settings.manage'), wrap(async (req, res) => (req.ctx.centerAdmin ? renderHome(req, res) : renderCenter(req, res, req.query.tab))));
router.get('/:section(doctors|staff|expenses|settings)', can('settings.manage'), wrap((req, res) => renderCenter(req, res, TAB_OF[req.params.section])));
const back = (tab) => (req) => (req.ctx.centerAdmin ? `/app/center/${PATHS[tab]}` : `/app/center?tab=${tab}`);
// Adding a doctor: a separate practice account with the doctor's own login (or an invitation for an existing account).
router.post('/doctors', can('settings.manage'), act(async (req) => {
  const r = await shared.addDoctor(req.ctx, req.body, { locale: req.locale, t: req.t });
  req.session.centerLink = r.link;
  req.session.centerLogin = { email: r.email, invited: Boolean(r.invited), emailed: Boolean(r.emailed) };
  flash(req, 'success', req.t(r.own ? 'center.own_added' : r.invited ? 'center.invited' : 'center.doctor_added', { email: r.email }));
}, back('practices')));
router.post('/staff', can('settings.manage'), act(async (req) => {
  const r = await shared.saveStaff(req.ctx, null, req.body);
  if (r.login && r.login.password) req.session.centerLogin = { email: String(req.body.login_email || '').trim().toLowerCase(), password: r.login.password };
  else if (r.login && r.login.link) req.session.centerLink = r.login.link;
  flash(req, 'success', req.t('center.staff_saved'));
}, back('staff')));
router.post('/staff/:id(\\d+)', can('settings.manage'), act(async (req) => { await shared.saveStaff(req.ctx, req.params.id, req.body); flash(req, 'success', req.t('center.staff_saved')); }, back('staff')));
router.post('/staff/:id(\\d+)/remove', can('settings.manage'), act(async (req) => { await shared.removeStaff(req.ctx, req.params.id); flash(req, 'success', req.t('center.staff_removed')); }, back('staff')));
router.post('/split', can('settings.manage'), act(async (req) => { await shared.setSplit(req.ctx, req.body); flash(req, 'success', req.t('common.updated')); }, back('costs')));
router.post('/expenses', can('settings.manage'), act(async (req) => { await shared.addExpense(req.ctx, req.body); flash(req, 'success', req.t('center.expense_added')); }, back('costs')));
router.post('/expenses/:id(\\d+)/delete', can('settings.manage'), act(async (req) => { await shared.removeExpense(req.ctx, req.params.id); flash(req, 'success', req.t('common.deleted')); }, back('costs')));
router.post('/salaries', can('settings.manage'), act(async (req) => { await shared.postSalaries(req.ctx, req.body.month, { t: req.t }); flash(req, 'success', req.t('center.salaries_posted')); }, back('costs')));

// ---------------------------------------------------------------- a practice's share of the centre's costs
router.get('/costs', can('expenses.view'), wrap(async (req, res) => {
  const center = await svc.ofBusiness(req.ctx.businessId);
  if (!center) return res.redirect('/app/expenses');
  const rows = await shared.myShares(req.ctx);
  const owed = rows.filter((r) => !r.paid_at).reduce((t, r) => t + Number(r.amount), 0);
  return res.page('pages/center/costs', { title: req.t('center.costs_title'), center, rows, owed, pageStyles: ['/css/center.css'] });
}));
router.post('/costs/:id(\\d+)/pay', can('expenses.manage'), act(async (req) => { await shared.payShare(req.ctx, req.params.id, req.body); flash(req, 'success', req.t('center.share_paid')); }, () => '/app/center/costs'));
router.post('/create', can('settings.manage'), act(async (req) => { await svc.create(req.ctx, { name: req.body.center_name, name_en: req.body.center_name_en }); flash(req, 'success', req.t('center.created')); }));
router.post('/rename', can('settings.manage'), act(async (req) => { await svc.rename(req.ctx, { name: req.body.center_name, name_en: req.body.center_name_en }); flash(req, 'success', req.t('common.updated')); }, back('settings')));
router.post('/invite', can('settings.manage'), act(async (req) => {
  const r = await svc.invite(req.ctx, req.body.email, { base: req.ctx.baseUrl, locale: req.locale, t: req.t });
  req.session.centerLink = r.link;
  flash(req, 'success', req.t('center.invited', { email: r.email }));
}, back('practices')));
router.post('/invites/:id(\\d+)/delete', can('settings.manage'), act(async (req) => { await svc.revokeInvite(req.ctx, req.params.id); flash(req, 'success', req.t('common.deleted')); }, back('practices')));
router.post('/share-cash', can('settings.manage'), act(async (req) => { await svc.setShareCash(req.ctx, req.body.on === '1'); flash(req, 'success', req.t('common.updated')); }));
router.post('/leave', can('settings.manage'), act(async (req) => { await svc.leave(req.ctx); flash(req, 'success', req.t('center.left')); }));
router.post('/members/:bid(\\d+)/remove', can('settings.manage'), act(async (req) => { await svc.leave(req.ctx, Number(req.params.bid)); flash(req, 'success', req.t('center.removed')); }, back('practices')));

// ---------------------------------------------------------------- the shared reception
const DESK_GRANT = ['frontdesk.use', 'appointments.view'];
async function deskData(req) {
  const center = await svc.ofBusiness(req.ctx.businessId);
  if (!center) return null;
  const members = await svc.members(center.id);
  const L = (ar, en) => (req.locale === 'en' && en ? en : ar);
  const visits = [];
  for (const m of members) { // eslint-disable-line no-restricted-syntax
    const ctx = await svc.actCtx(req.ctx, m.id, { need: 'frontdesk.use', grant: DESK_GRANT }); // eslint-disable-line no-await-in-loop
    const rows = await cashier.today({ ...ctx, permissions: new Set(DESK_GRANT) }); // eslint-disable-line no-await-in-loop
    rows.filter((a) => a.state !== 'missed').forEach((a) => visits.push({
      id: a.id, bid: m.id, practice: L(m.name, m.name_en), patient: a.patient_name, time: String(a.appointment_time || '').slice(0, 5),
      doctor: L(a.doctor_name, a.doctor_name_en) || '', color: a.doctor_color || null, state: a.state || cashier.flowState(a), paid: a.payment_status === 'paid',
    }));
  }
  visits.sort((x, y) => x.time.localeCompare(y.time) || x.id - y.id);
  // A practice's tab: only its visits (only practices of this centre are tabs).
  const tab = Number(req.query.p) || 0;
  if (tab && members.some((m) => m.id === tab)) { const keep = visits.filter((v) => v.bid === tab); visits.length = 0; visits.push(...keep); }
  const cols = ['expected', 'arrived', 'with_doctor', 'ready'];
  return { center, members, tab: members.some((m) => m.id === tab) ? tab : 0, cols, by: Object.fromEntries(cols.map((k) => [k, visits.filter((v) => v.state === k && !v.paid)])), done: visits.filter((v) => v.state === 'paid' || v.paid).length };
}
router.get('/desk', can('frontdesk.use'), wrap(async (req, res) => {
  const data = await deskData(req);
  if (!data) return res.redirect('/app/front-desk');
  return res.page('pages/center/desk', { title: req.t('center.desk_title'), ...data, pageStyles: ['/css/center.css'], pageScripts: ['/js/center.js'] });
}));
router.get('/desk/data', can('frontdesk.use'), wrap(async (req, res) => {
  const data = await deskData(req);
  res.set('Cache-Control', 'no-store').json(data ? { cols: data.cols, by: data.by, done: data.done } : null);
}));
router.post('/desk/:bid(\\d+)/:id(\\d+)/:action(check-in|uncheck|call-in|uncall)', can('frontdesk.use'), act(async (req) => {
  const ctx = await svc.actCtx(req.ctx, req.params.bid, { need: 'frontdesk.use', grant: DESK_GRANT });
  const id = Number(req.params.id);
  const { action } = req.params;
  if (action === 'check-in' || action === 'uncheck') await appts.checkIn(ctx, id, action === 'check-in');
  else await appts.callIn(ctx, id, action === 'call-in');
  flash(req, 'success', req.t(`center.done.${action}`));
}, (req) => `/app/center/desk${Number(req.body.p) > 0 ? `?p=${Number(req.body.p)}` : ''}`));

module.exports = router;
