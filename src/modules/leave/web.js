// Staff leave (/app/leave).
//  • everyone (every active member): their balance for this year, "ask for leave", their own requests (cancel while pending)
//  • requests (leave.manage): pending first — approve / reject with a note; every request with filters; record leave
//    for someone (approved at once); cancel an approved leave
//  • who is on leave (leave.manage): one month, grouped by date
//  • balances (leave.manage): used / remaining per person this year, the clinic's yearly allowance, a person's own allowance
//  • /payroll/lines/:id/deduct (payroll.manage): adds the month's unpaid leave as a deduction on a draft salary line
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError, E } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const att = require('../attendance/attendance.service');
const svc = require('./leave.service');

const router = express.Router();
const STYLES = ['/css/attendance.css'];

const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const roleLabel = (req, r) => (r && r.role_key && (r.is_system || r.is_system === 1) ? req.t(`roles.${r.role_key}`) : (r && r.role_name) || '—');
/** Translates an error code from this area's own table, then the shared one, else the English message. */
function errText(req, e) {
  if (e.code === 'VALIDATION_FAILED' && e.details) return `${req.t('errors.VALIDATION_FAILED')} ${Object.values(e.details).map((v) => translateMessage(req.locale, v)).join(' ')}`;
  for (const key of [`errors_leave.${e.code}`, `errors.${e.code}`]) { const s = req.t(key); if (s !== key) return s; }
  return e.message;
}
function nearMonths(today, back = 6, ahead = 6) {
  const out = [];
  const [y, m] = today.split('-').map(Number);
  for (let i = -ahead; i <= back; i += 1) out.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
  return out;
}
const backTo = (req, fallback = '/app/leave') => {
  const b = String(req.body._return || '');
  return /^\/app\/(leave|staff-payroll)(\/[^/\\][^\\]*)?(\?[^\\]*)?$/.test(b) && !b.includes('//') ? b : fallback;
};
/** Runs a short action; a refusal (already decided, not enough days…) comes back as a message on the page. */
const act = (fn) => wrap(async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 403) throw e;
    flash(req, 'error', errText(req, e));
    res.redirect(backTo(req));
  }
});

// ---------------------------------------------------------------- page
async function render(req, res, extra = {}) {
  const { ctx } = req;
  // A refusal of this area (not enough days, overlap…) shown in the dialog: this area's own wording.
  if (extra.formError && extra.formError.code) { const s = req.t(`errors_leave.${extra.formError.code}`); if (s !== `errors_leave.${extra.formError.code}`) extra.formError = { ...extra.formError, message: s }; }
  const manager = ctx.permissions.has(svc.MANAGE);
  const today = ctx.today;
  const year = today.slice(0, 4);
  let tab = String(extra.tab || req.query.tab || '');
  if (!manager || !['me', 'requests', 'calendar', 'balances'].includes(tab)) tab = manager && !extra.tab && !req.query.tab ? 'requests' : 'me';
  const [settings, staffAll, mine, myBalance, open] = await Promise.all([
    svc.settings(ctx.businessId), manager ? att.staff(ctx.businessId, ctx) : [], svc.list(ctx, { userId: ctx.userId, limit: 100 }),
    svc.balances(ctx.businessId, year, [ctx.userId]), svc.openDays(ctx.businessId),
  ]);
  const staffOptions = staffAll.filter((s) => s.status === 'active');
  const data = {
    title: req.t('leave.title'), tab, manager, year, settings, mine, my: myBalance.get(ctx.userId), openDays: open, kinds: svc.KINDS, statuses: svc.STATUSES,
    staffOptions, roleLabel: (r) => roleLabel(req, r), pendingCount: 0, pageStyles: STYLES,
  };
  if (manager) data.pendingCount = (await svc.list(ctx, { status: 'pending' })).length;
  if (tab === 'requests') {
    const status = svc.STATUSES.includes(req.query.status) ? req.query.status : '';
    const y = /^\d{4}$/.test(String(req.query.year || '')) ? req.query.year : year;
    Object.assign(data, { status, filterYear: y, years: [Number(year) + 1, Number(year), Number(year) - 1, Number(year) - 2].map(String), requests: await svc.list(ctx, { status: status || undefined, year: y }) });
    data.pending = status ? [] : data.requests.filter((r) => r.status === 'pending');
    if (!status) data.requests = data.requests.filter((r) => r.status !== 'pending');
  } else if (tab === 'calendar') {
    const month = isMonth(req.query.month) ? req.query.month : today.slice(0, 7);
    Object.assign(data, { month, months: nearMonths(today), cal: await svc.calendar(ctx, month) });
  } else if (tab === 'balances') {
    const b = await svc.balances(ctx.businessId, year, staffOptions.map((s) => s.user_id));
    data.rows = staffOptions.map((s) => ({ ...s, b: b.get(s.user_id) }));
    data.own = await svc.ownAllowances(ctx.businessId);
  }
  res.page('pages/leave/index', { ...data, ...extra });
}

router.get('/', wrap((req, res) => render(req, res)));

// Ask for leave (own account).
router.post('/requests', form(async (req, res) => {
  await svc.request(req.ctx, req.body);
  flash(req, 'success', req.t('leave.requested'));
  res.redirect('/app/leave?tab=me');
}, (req, res, extra) => render(req, res, { ...extra, tab: 'me', openDialog: 'request-dialog' })));

router.post('/requests/:id(\\d+)/cancel', act(async (req, res) => {
  await svc.cancel(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('leave.cancelled'));
  res.redirect(backTo(req));
}));

// Approve / reject (leave.manage).
// /decide carries the choice in the form (the dialog with a note has both buttons).
router.post('/requests/:id(\\d+)/:decision(approve|reject|decide)', can(svc.MANAGE), act(async (req, res) => {
  const decision = req.params.decision === 'decide' ? String(req.body.decision || '') : req.params.decision;
  const r = await svc.decide(req.ctx, Number(req.params.id), decision, req.body.note);
  flash(req, 'success', req.t(r.status === 'approved' ? 'leave.approved' : 'leave.rejected'));
  res.redirect(backTo(req, '/app/leave?tab=requests'));
}));

// Record leave for someone (leave.manage): approved at once.
router.post('/record', can(svc.MANAGE), form(async (req, res) => {
  await svc.record(req.ctx, req.body);
  flash(req, 'success', req.t('leave.recorded'));
  res.redirect(backTo(req, '/app/leave?tab=requests'));
}, (req, res, extra) => render(req, res, { ...extra, tab: 'requests', openDialog: 'record-dialog' })));

// The clinic's yearly allowance and a person's own allowance (leave.manage).
router.post('/settings', can(svc.MANAGE), form(async (req, res) => {
  await svc.saveSettings(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/leave?tab=balances');
}, (req, res, extra) => render(req, res, { ...extra, tab: 'balances', openDialog: 'settings-dialog' })));

router.post('/allowances/:id(\\d+)', can(svc.MANAGE), form(async (req, res) => {
  await svc.saveAllowance(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/leave?tab=balances');
}, (req, res, extra) => render(req, res, { ...extra, tab: 'balances', openDialog: 'allowance-dialog', formAction: `/app/leave/allowances/${Number(req.params.id)}` })));

// Unpaid leave → a deduction on a draft salary line (payroll.manage).
router.post('/payroll/lines/:id(\\d+)/deduct', can('payroll.manage'), act(async (req, res) => {
  const r = await svc.addPayrollDeduction(req.ctx, Number(req.params.id));
  if (!r) throw E.notFound('Salary');
  flash(req, 'success', req.t('leave.payroll_deduct_done', { n: r.days }));
  res.redirect(backTo(req, '/app/staff-payroll'));
}));

module.exports = router;
