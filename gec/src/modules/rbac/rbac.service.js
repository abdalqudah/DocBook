// Roles and the permissions of a signed-in employee; data scopes for queries on people.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { SYSTEM_ROLES, normalise, ALL } = require('./permissions');

/** Creates / refreshes the built-in roles (permissions of system roles follow the code). */
async function syncSystemRoles() {
  for (const r of SYSTEM_ROLES) {
    let row = await knex('roles').where({ key: r.key }).first(); // eslint-disable-line no-await-in-loop
    if (!row) {
      const [id] = await knex('roles').insert({ key: r.key, name_en: r.name_en, name_ar: r.name_ar, data_scope: r.scope, is_system: true }); // eslint-disable-line no-await-in-loop
      row = { id };
    }
    const perms = normalise(r.permissions);
    await knex.transaction(async (trx) => { // eslint-disable-line no-await-in-loop
      await trx('role_permissions').where({ role_id: row.id }).del();
      if (perms.length) await trx('role_permissions').insert(perms.map((p) => ({ role_id: row.id, permission: p })));
    });
  }
}

async function permissionsOf(roleId) {
  const rows = await knex('role_permissions').where({ role_id: roleId }).select('permission');
  return new Set(rows.map((r) => r.permission));
}

async function listRoles() {
  const roles = await knex('roles').orderBy('is_system', 'desc').orderBy('id');
  const counts = await knex('employees').select('role_id').count({ n: '*' }).groupBy('role_id');
  const perms = await knex('role_permissions').select('role_id', 'permission');
  return roles.map((r) => ({
    ...r,
    members: Number((counts.find((c) => c.role_id === r.id) || {}).n || 0),
    permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission),
  }));
}

async function saveRole(ctx, id, { name_en, name_ar, description, data_scope, permissions }) {
  const perms = normalise((permissions || []).filter((p) => ALL.includes(p)));
  return knex.transaction(async (trx) => {
    let roleId = id;
    if (id) {
      const before = await trx('roles').where({ id }).first();
      if (!before) throw E.notFound('Role');
      if (before.is_system) throw E.conflict('SYSTEM_ROLE', 'Built-in roles cannot be edited. Create a custom role instead.');
      const beforePerms = (await trx('role_permissions').where({ role_id: id })).map((p) => p.permission).sort();
      await trx('roles').where({ id }).update({ name_en, name_ar, description, data_scope, updated_at: new Date() });
      await trx('role_permissions').where({ role_id: id }).del();
      await audit.record(ctx, 'role.updated', { entityType: 'role', entityId: id, oldValues: { name_en: before.name_en, data_scope: before.data_scope, permissions: beforePerms }, newValues: { name_en, data_scope, permissions: perms.sort() } }, trx);
    } else {
      const key = `custom_${Date.now().toString(36)}`;
      [roleId] = await trx('roles').insert({ key, name_en, name_ar, description, data_scope, is_system: false });
      await audit.record(ctx, 'role.created', { entityType: 'role', entityId: roleId, newValues: { name_en, data_scope, permissions: perms } }, trx);
    }
    if (perms.length) await trx('role_permissions').insert(perms.map((p) => ({ role_id: roleId, permission: p })));
    return roleId;
  });
}

async function deleteRole(ctx, id) {
  const role = await knex('roles').where({ id }).first();
  if (!role) throw E.notFound('Role');
  if (role.is_system) throw E.conflict('SYSTEM_ROLE', 'Built-in roles cannot be deleted.');
  const used = await knex('employees').where({ role_id: id }).first('id');
  if (used) throw E.conflict('ROLE_IN_USE', 'Move the employees with this role to another role first.');
  await knex('roles').where({ id }).del();
  await audit.record(ctx, 'role.deleted', { entityType: 'role', entityId: id, oldValues: { name_en: role.name_en } });
}

/**
 * Restricts a query on people / pipeline records to what the employee may see.
 *   scope(q, staff, { owner: 'leads.counsellor_id', branch: 'leads.branch_id' })
 * own → assigned to me; branch → my branch (or assigned to me); all → no filter.
 */
function scope(q, staff, { owner, branch }) {
  if (!staff || !staff.employee) return q.whereRaw('1 = 0');
  const { dataScope, id: employeeId, branchId } = staff.employee;
  if (dataScope === 'all') return q;
  if (dataScope === 'branch' && branch && branchId) return q.where((w) => { w.where(branch, branchId); if (owner) w.orWhere(owner, employeeId); });
  return owner ? q.where(owner, employeeId) : q.whereRaw('1 = 0');
}

/** Same rule for one record already loaded: can this employee see it? */
function inScope(staff, record, { owner, branch }) {
  if (!staff || !staff.employee || !record) return false;
  const { dataScope, id, branchId } = staff.employee;
  if (dataScope === 'all') return true;
  if (owner && record[owner] === id) return true;
  return dataScope === 'branch' && branch && branchId && record[branch] === branchId;
}

module.exports = { syncSystemRoles, permissionsOf, listRoles, saveRole, deleteRole, scope, inScope };
