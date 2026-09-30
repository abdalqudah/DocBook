// Subscription gate for /app (worker: subscriptions). Mounted by src/routes/app.js after the nav middleware.
// While subscriptions are disabled (the default) this is a no-op: one cached settings read, then next().
// When enabled:
//  • res.locals.subscriptionBanner for people who manage the clinic (trial days left, payment due, expired);
//  • expired clinics are read-only: GET pages (records, look-ups, exports) keep working; writes are refused with a
//    friendly page, except paying, the person's own account/security, sign-out, notifications and data export;
//  • plan limits (doctors, staff logins, appointments per month) on the create routes.
const { wrap } = require('../../routes/helpers');
const { isJson } = require('../../middleware/context');
const subs = require('./subscriptions.service');

const MANAGER_ROLES = new Set(['owner', 'clinic_manager']);

function refuse(req, res, status, code, message, extra = {}) {
  res.status(status);
  if (isJson(req) || req.xhr) return res.json({ error: { code, message } });
  const ref = req.get('referer') || '';
  let backUrl = '/app';
  try { const u = new URL(ref); if (u.host === req.get('host') && u.pathname.startsWith('/app')) backUrl = u.pathname + u.search; } catch { /* no referer */ }
  return res.page('pages/subscriptions/blocked', { title: req.t('subscriptions.blocked_title'), code, message, backUrl, pageStyles: ['/css/subscriptions.css'], ...extra });
}

module.exports = wrap(async (req, res, next) => {
  const cfg = await subs.settings();
  if (!cfg.enabled || !req.business) return next();
  const st = await subs.state(req.business, req.ctx.today);
  req.subscription = st;
  res.locals.subscriptionState = st;
  const manager = MANAGER_ROLES.has(req.ctx.roleKey) || req.ctx.permissions.has('settings.manage');
  const onSubPage = req.path.startsWith('/settings/subscription');

  if (req.method === 'GET' && !onSubPage) {
    const s = st.sub.status;
    let banner = null;
    if (st.readOnly) banner = { kind: 'expired', tone: 'danger' };
    else if (s === 'past_due') banner = { kind: 'past_due', tone: 'warning', days: st.daysLeft };
    else if (s === 'trialing' && st.trialDaysLeft !== null && st.trialDaysLeft <= 14) banner = { kind: 'trial', tone: st.trialDaysLeft <= 3 ? 'warning' : 'info', days: st.trialDaysLeft };
    else if (s === 'cancelled') banner = { kind: 'cancelled', tone: 'warning', days: st.daysLeft, date: st.accessEnd };
    // Everyone sees that the clinic is read-only (so staff know why saving fails); the rest only for managers.
    if (banner && (manager || banner.kind === 'expired')) res.locals.subscriptionBanner = { ...banner, manager };
  }

  if (st.readOnly && !subs.allowedWhileReadOnly(req.method, req.path)) {
    return refuse(req, res, 402, 'SUBSCRIPTION_EXPIRED', req.t('errors_subscriptions.SUBSCRIPTION_EXPIRED'), { manager });
  }

  const kind = subs.limitFor(req.method, req.path, req.body || {});
  if (kind) {
    const r = await subs.checkLimit(req, kind);
    if (!r.ok) {
      return refuse(req, res, 402, 'PLAN_LIMIT', req.t(`errors_subscriptions.PLAN_LIMIT_${kind.toUpperCase()}`, { limit: r.limit, used: r.used }), { manager, limitKind: kind });
    }
  }
  return next();
});
