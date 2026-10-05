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

// The medical centre's administration account works for the doctors' practices on these pages: its shared reception
// books with any doctor, blocks times and adds surgeries — in the practice it picked (session.centerActAs, always one
// of the SAME centre's active practices, checked here), with only the reception permissions it holds itself.
const ACT_PATHS = ['/app/appointments', '/app/surgeries', '/app/api/slots', '/app/api/services'];
const ACT_GRANT = ['appointments.view', 'appointments.view_all', 'appointments.manage', 'frontdesk.use', 'patients.view', 'patients.create'];
const actPath = (req) => ACT_PATHS.some((p) => req.originalUrl === p || req.originalUrl.startsWith(`${p}/`) || req.originalUrl.startsWith(`${p}?`));

/** The centre's practices the administration account may act for, and the one it acts for now (null: none). */
async function actTarget(req, business) {
  const practices = await knex('businesses').where({ center_id: business.center_id, status: 'active' }).whereNot('kind', 'center_admin')
    .orderBy('center_joined_at').orderBy('id').select('id', 'name', 'name_en', 'specialty');
  const wanted = Number(req.query.practice) || Number(req.session.centerActAs) || 0;
  const practice = practices.find((p) => p.id === wanted) || practices[0] || null;
  if (practice) req.session.centerActAs = practice.id;
  return practice ? { practices, practice } : null;
}

async function withBusiness(req, res, next, businessId) {
  try {
    let [business, permissions] = await Promise.all([businesses.get(businessId), rbac.getUserPermissions(businessId, req.user.id)]);
    let membership = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.business_id': businessId, 'm.user_id': req.user.id })
      .first('m.doctor_id', 'm.job_title', 'm.photo_media_id', 'r.key as role_key', 'r.name as role_name', 'r.is_system');
    let chrome = business;
    let actAs = null;
    if (business.kind === 'center_admin' && business.center_id && actPath(req)) {
      const target = await actTarget(req, business);
      if (target) {
        const navPermissions = permissions;
        const practice = await businesses.get(target.practice.id);
        const granted = new Set(ACT_GRANT.filter((p) => navPermissions.has(p)));
        if (navPermissions.pagesOff) granted.pagesOff = navPermissions.pagesOff;
        const base = ACT_PATHS.find((p) => req.originalUrl.startsWith(p)).split('/').slice(0, 3).join('/');
        const keep = ['date', 'view'].filter((k) => typeof req.query[k] === 'string' && /^[\w-]{1,20}$/.test(req.query[k])).map((k) => `&${k}=${req.query[k]}`).join('');
        actAs = { adminBusinessId: business.id, practiceId: practice.id, practices: target.practices, navPermissions, base, keep };
        // The page chrome stays the centre's (logo, name, menu); dates and money follow the practice.
        chrome = { ...business, timezone: practice.timezone, currency: practice.currency };
        business = practice;
        businessId = practice.id; // eslint-disable-line no-param-reassign
        permissions = granted;
        membership = membership ? { ...membership, doctor_id: null } : membership;
      }
    }
    // A doctor account only ever sees its own schedule unless its role grants appointments.view_all.
    const ownDoctorId = membership && membership.doctor_id && !permissions.has('appointments.view_all') ? membership.doctor_id : null;
    req.ctx = {
      businessId, userId: req.user.id, userName: req.user.name, permissions, currency: business.currency, timezone: business.timezone,
      roleKey: membership && membership.role_key, doctorId: membership ? membership.doctor_id : null, ownDoctorId, centerId: business.center_id || null, centerAdmin: business.kind === 'center_admin' || Boolean(actAs), // the medical centre's administration account (not a clinic)
      actAs, viaPractice: actAs ? actAs.adminBusinessId : undefined,
      ip: req.ip, userAgent: req.get('user-agent'), sessionId: req.sessionID, locale: req.locale, baseUrl: res.locals.baseUrl,
    };
    req.business = business;
    res.locals.business = chrome;
    res.locals.actAs = actAs;
    // The clinic's white logo (website Theme & brand), used by the sidebar / top bar in dark mode.
    const chromeId = chrome.id;
    res.locals.logoDarkSrc = await require('../core/cache').remember(`site:${chromeId}:logodark`, async () => { // eslint-disable-line global-require
      const businessId = chromeId; // eslint-disable-line no-shadow
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
      const own = actAs ? { ...req.ctx, businessId: chromeId, permissions: actAs.navPermissions } : req.ctx; // the signed-in account's own inbox
      res.locals.unreadNotifications = await notifications.unreadCount(own);
      res.locals.unreadChat = await require('../modules/chat/chat.service').unreadTotal(own).catch(() => 0); // eslint-disable-line global-require
      // Attendance in the top bar (every staff member except the owner / platform admin): clocked in since when, and
      // whether this clinic records attendance by QR only.
      if (membership && membership.role_key !== 'owner' && !req.user.is_platform_admin && !actAs && business.kind !== 'center_admin') {
        try {
          const att = require('../modules/attendance/attendance.service'); // eslint-disable-line global-require
          const [open, st] = await Promise.all([att.openShift(businessId, req.user.id), att.settings(businessId)]);
          res.locals.myAttendance = { open: Boolean(open), since: open ? att.localTime(business.timezone || 'Asia/Amman', open.clock_in) : null, qrOnly: st.qrOnly };
        } catch { res.locals.myAttendance = null; }
      }
      // The signed-in member's photo (My account, else their doctor's photo) for the avatar in the top bar.
      res.locals.myDoctorId = membership && membership.doctor_id ? membership.doctor_id : null; // My profile & services (a doctor's own login)
      res.locals.myPhoto = membership ? await require('../modules/integrations/media.service').memberPhoto(businessId, { photoMediaId: membership.photo_media_id, doctorId: membership.doctor_id }).catch(() => null) : null; // eslint-disable-line global-require
    }
    // Any successful write refreshes this workspace's cached figures.
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) cache.forgetPrefix(`fin:${businessId}`); });
    return next();
  } catch (err) { return next(err); }
}

const can = (permission) => (req, res, next) => (req.ctx?.permissions.has(permission) ? next() : next(E.forbidden(permission)));
const canAny = (...perms) => (req, res, next) => (perms.some((p) => req.ctx?.permissions.has(p)) ? next() : next(E.forbidden(perms.join('|'))));

module.exports = { loadUser, requireAuth, resolveBusiness, can, canAny, isJson };
