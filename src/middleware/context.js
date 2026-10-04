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
  // Attendance QR scanned while signed out: the code only lives 30 s, so remember that a VALID code was
  // scanned (clinic + time, never the code itself) and let the scan page honour it for a few minutes after login.
  if (req.method === 'GET' && req.originalUrl.split('?')[0] === '/app/attendance/scan' && req.query.t) {
    try {
      const tok = require('../modules/attendance/attendance.service').verifyToken(req.query.t); // eslint-disable-line global-require
      req.session.pendingScan = { b: tok.businessId, at: Date.now() };
      req.session.returnTo = '/app/attendance/scan?resume=1';
    } catch { /* expired or forged: the scan page will ask to scan again */ }
  }
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
      // A rep / warehouse account has no clinic: send it to the vendor portal instead of "create a clinic".
      if (await knex('vendor_users').where({ user_id: req.user.id }).first('id')) return res.redirect('/vendor');
      return res.redirect('/workspaces/new');
    }
    // The rest of the request works in this clinic's own database (src/db/tenant.js) — or the main one.
    const tenant = require('../db/tenant'); // eslint-disable-line global-require
    return tenant.run(await tenant.dbOf(businessId), () => withBusiness(req, res, next, businessId));
  } catch (err) { return next(err); }
}

async function withBusiness(req, res, next, businessId) {
  try {
    const [business, permissions] = await Promise.all([businesses.get(businessId), rbac.getUserPermissions(businessId, req.user.id)]);
    const membership = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.business_id': businessId, 'm.user_id': req.user.id })
      .first('m.doctor_id', 'm.job_title', 'r.key as role_key', 'r.name as role_name', 'r.is_system');
    // A doctor account only ever sees its own schedule unless its role grants appointments.view_all.
    const ownDoctorId = membership && membership.doctor_id && !permissions.has('appointments.view_all') ? membership.doctor_id : null;
    req.ctx = {
      businessId, userId: req.user.id, userName: req.user.name, permissions, currency: business.currency, timezone: business.timezone,
      roleKey: membership && membership.role_key, doctorId: membership ? membership.doctor_id : null, ownDoctorId, centerId: business.center_id || null, centerAdmin: business.kind === 'center_admin', // the medical centre's administration account (not a clinic)
      ip: req.ip, userAgent: req.get('user-agent'), sessionId: req.sessionID, locale: req.locale, baseUrl: res.locals.baseUrl,
    };
    req.business = business;
    res.locals.business = business;
    // The clinic's white logo (website Theme & brand), used by the sidebar / top bar in dark mode.
    res.locals.logoDarkSrc = await require('../core/cache').remember(`site:${businessId}:logodark`, async () => { // eslint-disable-line global-require
      try {
        const site = await knex('clinic_sites').where({ business_id: businessId }).first('draft_version_id', 'live_version_id');
        const vid = site && (site.draft_version_id || site.live_version_id);
        const v = vid ? await knex('clinic_site_versions').where({ business_id: businessId, id: vid }).first('doc') : null;
        const doc = v ? (typeof v.doc === 'string' ? JSON.parse(v.doc) : v.doc) : null;
        const id = doc && doc.brand && Number(doc.brand.logoDarkMediaId);
        return id && (await knex('clinic_media').where({ business_id: businessId, id }).first('id')) ? `/app/media/${id}` : null;
      } catch { return null; }
    }, 300_000) || null;
    res.locals.membership = membership;
    res.locals.can = (p) => permissions.has(p);
    res.locals.canAny = (...ps) => ps.some((p) => permissions.has(p));
    res.locals.currency = business.currency;
    if (!isJson(req)) {
      res.locals.workspaces = await businesses.listForUser(req.user.id);
      res.locals.unreadNotifications = await notifications.unreadCount(req.ctx);
      res.locals.unreadChat = await require('../modules/chat/chat.service').unreadTotal(req.ctx).catch(() => 0); // eslint-disable-line global-require
    }
    // Any successful write refreshes this workspace's cached figures.
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) cache.forgetPrefix(`fin:${businessId}`); });
    return next();
  } catch (err) { return next(err); }
}

const can = (permission) => (req, res, next) => (req.ctx?.permissions.has(permission) ? next() : next(E.forbidden(permission)));
const canAny = (...perms) => (req, res, next) => (perms.some((p) => req.ctx?.permissions.has(p)) ? next() : next(E.forbidden(perms.join('|'))));

module.exports = { loadUser, requireAuth, resolveBusiness, can, canAny, isJson };
