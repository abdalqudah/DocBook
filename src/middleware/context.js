// Request context: the signed-in user, the active workspace and the member's permissions.
// Tenant isolation: the workspace comes from a verified membership, never from request input,
// and every service receives req.ctx.businessId.
const knex = require('../db/knex');
const cache = require('../core/cache');
const { E } = require('../core/errors');
const authService = require('../modules/auth/auth.service');
const businesses = require('../modules/businesses/business.service');
const rbac = require('../modules/rbac/rbac.service');
const notifications = require('../modules/notifications/notification.service');

const isJson = (req) => req.originalUrl.startsWith('/api/') || (req.get('accept') || '').includes('application/json');

async function loadUser(req, res, next) {
  try {
    if (req.session?.userId) {
      const user = await authService.findUser(req.session.userId);
      if (user && user.status === 'active') req.user = user;
      else delete req.session.userId;
    }
    next();
  } catch (err) { next(err); }
}

function requireAuth(req, res, next) {
  // Accounts created with a temporary password must choose their own before using the app.
  if (req.user && req.user.must_change_password && !isJson(req)) return res.redirect('/password/new');
  if (req.user) return next();
  if (isJson(req)) return next(E.unauthenticated());
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

async function resolveBusiness(req, res, next) {
  try {
    let businessId = req.session.businessId;
    const usable = async (id) => {
      if (!id || !(await businesses.isMember(req.user.id, id))) return false;
      const b = await businesses.get(id);
      return Boolean(b) && (b.status || 'active') === 'active';
    };
    if (!(await usable(businessId))) {
      // Suspended clinics are skipped: their staff can't open them until the platform reactivates them.
      const list = [];
      for (const b of await businesses.listForUser(req.user.id)) if (await usable(b.id)) list.push(b); // eslint-disable-line no-await-in-loop
      const preferred = list.find((b) => b.id === req.user.last_business_id) || list[0];
      businessId = preferred ? preferred.id : null;
      req.session.businessId = businessId;
    }
    if (!businessId) {
      if (isJson(req)) throw E.noBusiness();
      return res.redirect('/workspaces/new');
    }
    const [business, permissions] = await Promise.all([businesses.get(businessId), rbac.getUserPermissions(businessId, req.user.id)]);
    const membership = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.business_id': businessId, 'm.user_id': req.user.id })
      .first('m.doctor_id', 'm.job_title', 'r.key as role_key', 'r.name as role_name', 'r.is_system');
    // A doctor account only ever sees its own schedule unless its role grants appointments.view_all.
    const ownDoctorId = membership && membership.doctor_id && !permissions.has('appointments.view_all') ? membership.doctor_id : null;
    req.ctx = {
      businessId, userId: req.user.id, userName: req.user.name, permissions, currency: business.currency, timezone: business.timezone,
      roleKey: membership && membership.role_key, doctorId: membership ? membership.doctor_id : null, ownDoctorId,
      ip: req.ip, userAgent: req.get('user-agent'), sessionId: req.sessionID, locale: req.locale,
    };
    req.business = business;
    res.locals.business = business;
    res.locals.membership = membership;
    res.locals.can = (p) => permissions.has(p);
    res.locals.canAny = (...ps) => ps.some((p) => permissions.has(p));
    res.locals.currency = business.currency;
    if (!isJson(req)) {
      res.locals.workspaces = await businesses.listForUser(req.user.id);
      res.locals.unreadNotifications = await notifications.unreadCount(req.ctx);
    }
    // Any successful write refreshes this workspace's cached figures.
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) cache.forgetPrefix(`fin:${businessId}`); });
    return next();
  } catch (err) { return next(err); }
}

const can = (permission) => (req, res, next) => (req.ctx?.permissions.has(permission) ? next() : next(E.forbidden(permission)));
const canAny = (...perms) => (req, res, next) => (perms.some((p) => req.ctx?.permissions.has(p)) ? next() : next(E.forbidden(perms.join('|'))));

module.exports = { loadUser, requireAuth, resolveBusiness, can, canAny, isJson };
