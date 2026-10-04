// Team and role safety: a clinic manager cannot rise above their own access — no custom role with permissions they
// lack, no change to their own membership or an owner's, no owner role, no reset link for someone above them — while
// the owner keeps every power and a manager keeps their everyday work (built-in roles for other staff).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let bid; let owner; let manager; let staff;

async function member(roleKey, name) {
  const role = await rbac.getRoleByKey(bid, roleKey);
  const id = await knex.transaction((trx) => auth.createUser(trx, { name, email: `${name}-${tag}@sec.test`, password: 'Passw0rd!x' }));
  const [mid] = await knex('memberships').insert({ business_id: bid, user_id: id, role_id: role.id, status: 'active' });
  rbac.invalidate(bid);
  return { userId: id, membershipId: mid };
}
const ctxOf = async (m, roleKey) => ({ businessId: bid, userId: m.userId, roleKey, permissions: await rbac.getUserPermissions(bid, m.userId), locale: 'en', ip: '127.0.0.1' });

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Owner', email: `own-${tag}@sec.test`, password: 'Passw0rd!x' }));
  bid = await knex.transaction((trx) => businesses.create(uid, { name: 'Safe clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  const om = await knex('memberships').where({ business_id: bid, user_id: uid }).first('id');
  owner = { userId: uid, membershipId: om.id };
  manager = await member('clinic_manager', 'manager');
  staff = await member('receptionist', 'reception');
});
test.after(async () => { await knex.destroy(); });

const denied = (e) => e && e.status === 403;

test('a manager cannot build or take a role above their own access', async () => {
  const m = await ctxOf(manager, 'clinic_manager');
  assert.ok(!m.permissions.has('data.manage'), 'the built-in manager role lacks data.manage');
  await assert.rejects(rbac.saveRole(m, { name: 'All', permissions: ['data.manage', 'finance.manage'] }), denied);
  // a role within their own access is fine
  const okId = await rbac.saveRole(m, { name: 'Front', permissions: ['appointments.view'] });
  assert.ok(okId);
  // adding a permission they lack to an existing role is refused
  await assert.rejects(rbac.saveRole(m, { id: okId, name: 'Front', permissions: ['appointments.view', 'data.manage'] }), denied);
  // own membership, an owner's membership, the owner role: refused
  const ownerRole = await rbac.getRoleByKey(bid, 'owner');
  await assert.rejects(businesses.changeMember(m, manager.membershipId, { roleId: okId, status: 'active' }), denied);
  await assert.rejects(businesses.changeMember(m, owner.membershipId, { roleId: okId, status: 'active' }), denied);
  await assert.rejects(businesses.changeMember(m, staff.membershipId, { roleId: ownerRole.id, status: 'active' }), denied);
  await assert.rejects(businesses.removeMember(m, owner.membershipId), denied);
  // a custom role made by the owner with more access cannot be handed out by the manager
  const o = await ctxOf(owner, 'owner');
  const big = await rbac.saveRole(o, { name: 'Big', permissions: ['data.manage'] });
  await assert.rejects(businesses.changeMember(m, staff.membershipId, { roleId: big, status: 'active' }), denied);
  // everyday work still works: a built-in role for other staff
  const acc = await rbac.getRoleByKey(bid, 'accountant');
  await businesses.changeMember(m, staff.membershipId, { roleId: acc.id, status: 'active' });
  assert.equal((await knex('memberships').where({ id: staff.membershipId }).first('role_id')).role_id, acc.id);
});

test('a manager gets no reset link for the owner; the owner still manages everything', async () => {
  const m = await ctxOf(manager, 'clinic_manager');
  let r = null; let err = null;
  try { r = await businesses.adminResetLink(m, owner.membershipId); } catch (e) { err = e; }
  assert.ok(!(r && r.link), 'no link handed to the manager');
  assert.ok(err ? err.code === 'RESET_NEEDS_EMAIL' : r.emailed, 'the link only goes to the owner by e-mail');
  // the manager may still help a receptionist (no more access than their own)
  const back = await rbac.getRoleByKey(bid, 'receptionist');
  await businesses.changeMember(m, staff.membershipId, { roleId: back.id, status: 'active' });
  r = await businesses.adminResetLink(m, staff.membershipId);
  assert.ok(r.link, 'a link for a member below the manager');
  // owner powers are intact
  const o = await ctxOf(owner, 'owner');
  const ownerRole = await rbac.getRoleByKey(bid, 'owner');
  await businesses.changeMember(o, manager.membershipId, { roleId: ownerRole.id, status: 'active' });
  assert.equal(await knex('memberships as mm').join('roles as rr', 'rr.id', 'mm.role_id').where({ 'mm.id': manager.membershipId }).first('rr.key').then((x) => x.key), 'owner');
});
