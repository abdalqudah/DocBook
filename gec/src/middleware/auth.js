// Who is signed in, what they may do, and the guards for staff and student routes.
const knex = require('../db/knex');
const { E } = require('../core/errors');
const { permissionsOf } = require('../modules/rbac/rbac.service');

/** Loads req.user (+ req.staff for employees with role, permissions, data scope) and req.ctx for the audit log. */
async function loadUser(req, res, next) {
  try {
    req.ctx = { userId: null, ip: req.ip, userAgent: String(req.get('user-agent') || '').slice(0, 255) };
    req.can = () => false;
    const id = req.session && req.session.userId;
    if (!id) return next();
    const user = await knex('users').where({ id }).first('id', 'kind', 'email', 'name', 'phone', 'locale', 'status', 'must_change_password');
    if (!user || user.status === 'disabled' || user.kind !== req.session.kind) {
      return req.session.regenerate(() => next());
    }
    req.user = user;
    req.ctx.userId = user.id;
    if (user.kind === 'staff') {
      const emp = await knex('employees as e').join('roles as r', 'r.id', 'e.role_id').where('e.user_id', user.id)
        .first('e.id', 'e.role_id', 'e.branch_id', 'e.job_title', 'e.photo', 'e.is_counsellor', 'r.key as role_key', 'r.name_en as role_en', 'r.name_ar as role_ar', 'r.data_scope');
      if (!emp) return req.session.regenerate(() => next()); // staff account without an employee record: no access
      const perms = await permissionsOf(emp.role_id);
      req.staff = { user, employee: { id: emp.id, roleId: emp.role_id, roleKey: emp.role_key, roleName: { en: emp.role_en, ar: emp.role_ar }, branchId: emp.branch_id, dataScope: emp.data_scope, jobTitle: emp.job_title, photo: emp.photo, isCounsellor: Boolean(emp.is_counsellor) }, permissions: perms };
      req.can = (p) => perms.has(p);
    }
    return next();
  } catch (e) { return next(e); }
}

const wantsJson = (req) => req.originalUrl.startsWith('/api/') || String(req.get('accept') || '').includes('application/json');

/** Staff-only routes. Unauthenticated browsers go to the staff sign-in page. */
function requireStaff(req, res, next) {
  if (!req.staff) {
    if (wantsJson(req)) return next(E.unauthenticated());
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/staff/login');
  }
  if (req.user.must_change_password && !/^\/staff\/(password|logout)/.test(req.originalUrl)) return res.redirect('/staff/password');
  return next();
}

function requireStudent(req, res, next) {
  if (!req.user || req.user.kind !== 'student') {
    if (wantsJson(req)) return next(E.unauthenticated());
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  return next();
}

/** Route guard: can('leads.manage') — any of several: can('a', 'b'). */
function can(...perms) {
  return (req, res, next) => (req.staff && perms.some((p) => req.can(p)) ? next() : next(E.forbidden(perms.join(' | '))));
}

module.exports = { loadUser, requireStaff, requireStudent, can, wantsJson };
