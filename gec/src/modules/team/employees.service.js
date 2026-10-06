// Employees: staff accounts with a role, branch, manager and counsellor settings.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { hashPassword, endSessionsOf, createReset } = require('../auth/auth.service');
const { randomToken } = require('../../core/tokens');

async function list(params = {}) {
  const q = knex('employees as e').join('users as u', 'u.id', 'e.user_id').join('roles as r', 'r.id', 'e.role_id')
    .leftJoin('branches as b', 'b.id', 'e.branch_id').leftJoin('employees as me', 'me.id', 'e.manager_id').leftJoin('users as mu', 'mu.id', 'me.user_id')
    .select('e.*', 'u.name', 'u.email', 'u.phone', 'u.status', 'u.last_login_at', 'r.name_en as role_en', 'r.name_ar as role_ar', 'r.key as role_key', 'b.name as branch_name', 'mu.name as manager_name')
    .orderBy('u.name');
  if (params.q) q.where((w) => w.where('u.name', 'like', `%${String(params.q).replace(/[%_]/g, '')}%`).orWhere('u.email', 'like', `%${String(params.q).replace(/[%_]/g, '')}%`));
  if (/^\d+$/.test(params.role || '')) q.where('e.role_id', Number(params.role));
  if (/^\d+$/.test(params.branch || '')) q.where('e.branch_id', Number(params.branch));
  if (['active', 'invited', 'disabled'].includes(params.status)) q.where('u.status', params.status);
  return q;
}

async function get(id) {
  const e = await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', id)
    .first('e.*', 'u.name', 'u.email', 'u.phone', 'u.status', 'u.locale', 'u.last_login_at', 'u.must_change_password');
  if (!e) throw E.notFound('Employee');
  e.countries = parse(e.countries);
  return e;
}
const parse = (v) => { if (!v) return []; if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch { return []; } };

/** Active employees for pickers (assign to…). `counsellorsOnly` limits to counsellors. */
async function options({ counsellorsOnly = false, branchId = null } = {}) {
  const q = knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('u.status', 'active').select('e.id', 'u.name', 'e.branch_id', 'e.is_counsellor').orderBy('u.name');
  if (counsellorsOnly) q.where('e.is_counsellor', true);
  if (branchId) q.where('e.branch_id', branchId);
  return q;
}

/** Only a Super Admin can create or promote Super Admins (no privilege escalation by Admins). */
async function guardRole(staff, roleId) {
  const role = await knex('roles').where({ id: roleId }).first();
  if (!role) throw E.validation({ role_id: 'Choose a valid option.' });
  if (role.key === 'super_admin' && staff.employee.roleKey !== 'super_admin') throw E.forbidden('super_admin');
  return role;
}

/**
 * Creates an employee. mode 'invite' → e-mail a link to choose a password (returned link if mail is off);
 * mode 'password' → a temporary password they must change at first sign-in.
 */
async function create(ctx, staff, data) {
  await guardRole(staff, data.role_id);
  const email = String(data.email).toLowerCase();
  if (await knex('users').where({ kind: 'staff', email }).first('id')) throw E.validation({ email: 'An employee with this email already exists.' });
  const temp = data.mode === 'password' ? data.temp_password : randomToken(18);
  let empId;
  await knex.transaction(async (trx) => {
    const [userId] = await trx('users').insert({
      kind: 'staff', email, name: data.name, phone: data.phone || null, locale: data.locale || 'en',
      password_hash: await hashPassword(temp), status: data.mode === 'password' ? 'active' : 'invited', must_change_password: data.mode === 'password',
    });
    [empId] = await trx('employees').insert({
      user_id: userId, role_id: data.role_id, branch_id: data.branch_id || null, manager_id: data.manager_id || null,
      job_title: data.job_title || null, department: data.department || null, is_counsellor: Boolean(data.is_counsellor),
      auto_assign: data.auto_assign !== false, countries: JSON.stringify(data.countries || []),
    });
    await audit.record(ctx, 'employee.created', { entityType: 'employee', entityId: empId, newValues: { email, name: data.name, role_id: data.role_id, branch_id: data.branch_id, mode: data.mode } }, trx);
  });
  let link = null;
  if (data.mode !== 'password') {
    const r = await createReset(email, 'staff');
    link = r ? r.link : null;
  }
  return { id: empId, inviteLink: link };
}

async function update(ctx, staff, id, data) {
  const before = await get(id);
  const role = await guardRole(staff, data.role_id);
  const beforeRole = await knex('roles').where({ id: before.role_id }).first();
  if (beforeRole.key === 'super_admin' && staff.employee.roleKey !== 'super_admin') throw E.forbidden('super_admin');
  if (before.user_id === ctx.userId && data.role_id !== before.role_id) throw E.validation({ role_id: 'You cannot change your own role.' });
  const empRow = {
    role_id: data.role_id, branch_id: data.branch_id || null, manager_id: data.manager_id && Number(data.manager_id) !== id ? data.manager_id : null,
    job_title: data.job_title || null, department: data.department || null, is_counsellor: Boolean(data.is_counsellor), auto_assign: Boolean(data.auto_assign),
    countries: JSON.stringify(data.countries || []),
  };
  const userRow = { name: data.name, phone: data.phone || null };
  const d = audit.diff({ ...before, countries: JSON.stringify(before.countries) }, { ...empRow, ...userRow });
  if (!d.changed) return false;
  await knex.transaction(async (trx) => {
    await trx('employees').where({ id }).update({ ...empRow, updated_at: new Date() });
    await trx('users').where({ id: before.user_id }).update({ ...userRow, updated_at: new Date() });
    await audit.record(ctx, d.newValues.role_id !== undefined ? 'employee.role_changed' : 'employee.updated', { entityType: 'employee', entityId: id, oldValues: d.oldValues, newValues: { ...d.newValues, role_key: role.key } }, trx);
  });
  return true;
}

async function setStatus(ctx, staff, id, status) {
  const e = await get(id);
  if (e.user_id === ctx.userId) throw E.validation({ status: 'You cannot disable your own account.' });
  const role = await knex('roles').where({ id: e.role_id }).first();
  if (role.key === 'super_admin' && staff.employee.roleKey !== 'super_admin') throw E.forbidden('super_admin');
  await knex('users').where({ id: e.user_id }).update({ status, updated_at: new Date() });
  if (status === 'disabled') await endSessionsOf(e.user_id);
  await audit.record(ctx, status === 'disabled' ? 'employee.disabled' : 'employee.enabled', { entityType: 'employee', entityId: id, oldValues: { status: e.status }, newValues: { status } });
}

/** A fresh password link for an employee (shown to the admin when e-mail is not set up). */
/**
 * A password-reset link for an employee. Admin and Super Admin accounts can only be reset by a Super Admin, and
 * nobody resets their own account here (that is what "Forgot password" is for) — otherwise the link would let a
 * lower role take over a higher one.
 */
async function resetLink(ctx, staff, id) {
  const e = await get(id);
  if (e.user_id === ctx.userId) throw E.validation({ status: 'Use “Forgot password” for your own account.' });
  const role = await knex('roles').where({ id: e.role_id }).first();
  if (['super_admin', 'admin'].includes(role.key) && staff.employee.roleKey !== 'super_admin') throw E.forbidden('super_admin');
  const r = await createReset(e.email, 'staff');
  await audit.record(ctx, 'employee.reset_link', { entityType: 'employee', entityId: id });
  return r ? { link: r.link, user: r.user } : null;
}

module.exports = { list, get, options, create, update, setStatus, resetLink, parse };
