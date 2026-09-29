const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { SYSTEM_ROLES, normalise } = require('./permissions');

const parse = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })());

/** Creates this workspace's copy of every system role (called when a workspace is created). */
async function seedRoles(businessId, trx = knex) {
  for (const r of SYSTEM_ROLES) {
    const exists = await trx('roles').where({ business_id: businessId, key: r.key }).first(); // eslint-disable-line no-await-in-loop
    if (!exists) {
      await trx('roles').insert({ business_id: businessId, key: r.key, name: r.key, is_system: true, permissions: JSON.stringify(normalise(r.permissions)) }); // eslint-disable-line no-await-in-loop
    }
  }
}

/**
 * Built-in roles are read-only in the UI, so their permissions follow the catalog: when a release adds a
 * permission (e.g. attendance), every clinic's system roles are brought up to date at boot.
 */
async function syncSystemRoles() {
  for (const r of SYSTEM_ROLES) {
    const perms = JSON.stringify(normalise(r.permissions));
    await knex('roles').where({ key: r.key, is_system: true }).whereNot({ permissions: perms }).update({ permissions: perms }); // eslint-disable-line no-await-in-loop
  }
}

async function loadPermissions(businessId, userId) {
  const row = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id')
    .where({ 'm.business_id': businessId, 'm.user_id': userId, 'm.status': 'active' }).first('r.permissions', 'r.key');
  if (!row) return new Set();
  // The owner role always holds every permission, even ones added in a later release.
  if (row.key === 'owner') return new Set(require('./permissions').ALL); // eslint-disable-line global-require
  return new Set(parse(row.permissions));
}

const getUserPermissions = (businessId, userId) => cache.remember(`perm:${businessId}:${userId}`, () => loadPermissions(businessId, userId));
const invalidate = (businessId) => cache.forgetPrefix(`perm:${businessId}:`);

async function listRoles(businessId) {
  const roles = await knex('roles').where({ business_id: businessId }).orderBy([{ column: 'is_system', order: 'desc' }, { column: 'id' }]);
  const counts = await knex('memberships').where({ business_id: businessId }).groupBy('role_id').select('role_id').count({ n: '*' });
  const byRole = Object.fromEntries(counts.map((c) => [c.role_id, Number(c.n)]));
  return roles.map((r) => ({ ...r, permissions: parse(r.permissions), members: byRole[r.id] || 0 }));
}

async function getRole(businessId, id) {
  const role = await knex('roles').where({ business_id: businessId, id }).first();
  if (!role) throw E.notFound('Role');
  return { ...role, permissions: parse(role.permissions) };
}

const getRoleByKey = (businessId, key, trx = knex) => trx('roles').where({ business_id: businessId, key }).first();

async function saveRole(ctx, { id, name, description, permissions }) {
  const perms = normalise(permissions || []);
  if (id) {
    const role = await getRole(ctx.businessId, id);
    if (role.key === 'owner') throw E.conflict('ROLE_LOCKED', 'The Owner role always has every permission.');
    await knex('roles').where({ id }).update({ name: role.is_system ? role.name : name, description: description || null, permissions: JSON.stringify(perms), updated_at: new Date() });
    await audit.record(ctx, 'role.updated', { entityType: 'role', entityId: id, oldValues: { permissions: role.permissions.join(',') }, newValues: { name, permissions: perms.join(',') } });
    invalidate(ctx.businessId);
    return id;
  }
  const [newId] = await knex('roles').insert({ business_id: ctx.businessId, key: `custom_${Date.now().toString(36)}`, name, description: description || null, is_system: false, permissions: JSON.stringify(perms) });
  await audit.record(ctx, 'role.created', { entityType: 'role', entityId: newId, newValues: { name, permissions: perms.join(',') } });
  return newId;
}

async function deleteRole(ctx, id) {
  const role = await getRole(ctx.businessId, id);
  if (role.is_system) throw E.conflict('ROLE_LOCKED', 'Built-in roles cannot be deleted.');
  const [{ n }] = await knex('memberships').where({ role_id: id }).count({ n: '*' });
  if (Number(n) > 0) throw E.conflict('ROLE_IN_USE', 'Move the members of this role to another role first.');
  await knex('roles').where({ id }).del();
  await audit.record(ctx, 'role.deleted', { entityType: 'role', entityId: id, oldValues: { name: role.name } });
}

module.exports = { seedRoles, syncSystemRoles, getUserPermissions, invalidate, listRoles, getRole, getRoleByKey, saveRole, deleteRole };
