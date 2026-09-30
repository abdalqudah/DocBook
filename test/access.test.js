// Per-member page access (Settings → Team → Page access), against the test database (docbook_test).
// Covers: allow adds the page's permissions + menu item (and only that page), deny hides the page, blocks its addresses
// and keeps permissions another open page still needs, the owner can't be restricted, a manager can't give beyond their
// own access nor change themselves / the owner, the permission cache is refreshed on every change, and the audit trail.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const nav = require('../src/routes/nav');
const access = require('../src/modules/access/access.service');
const gate = require('../src/modules/access/gate');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let owner; let manager; let reception; let accountant;

async function member(ownerCtx, roleKey, name) {
  const role = await rbac.getRoleByKey(ownerCtx.businessId, roleKey);
  const email = `${roleKey}${tag}@acc.test`;
  await businesses.addStaff(ownerCtx, { name, email, roleId: role.id, mode: 'password', locale: 'en' });
  const u = await knex('users').where({ email }).first('id');
  const m = await knex('memberships').where({ business_id: ownerCtx.businessId, user_id: u.id }).first('id');
  return { userId: u.id, membershipId: m.id, businessId: ownerCtx.businessId, roleKey };
}
const perms = (who) => rbac.getUserPermissions(who.businessId, who.userId);
const ctxOf = async (who) => ({ businessId: who.businessId, userId: who.userId, roleKey: who.roleKey, permissions: await perms(who), ip: '127.0.0.1' });
const pj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const menuKeys = (p) => nav.forUser(p, { modulesOff: p.pagesOff || new Set() }).flatMap((g) => g.items.map((i) => i.key));

async function runGate(who, path, method = 'GET') {
  const out = {};
  const req = { ctx: { permissions: await perms(who), roleKey: who.roleKey }, baseUrl: '/app', path, originalUrl: `/app${path}`, method, t: (k) => k, get: () => '' };
  const res = {
    locals: {},
    status(s) { out.status = s; return this; },
    page(view) { out.view = view; return this; },
    json(b) { out.json = b; return this; },
    redirect(to) { out.redirect = to; return this; },
  };
  await new Promise((resolve, reject) => { res.page = (view) => { out.view = view; resolve(); }; res.redirect = (to) => { out.redirect = to; resolve(); }; gate(req, res, (e) => (e ? reject(e) : (out.next = true, resolve()))); });
  return out;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: `own${tag}@acc.test`, password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Access clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  owner = { businessId, userId, roleKey: 'owner' };
  const oc = await ctxOf(owner);
  manager = await member(oc, 'clinic_manager', 'Manager');
  reception = await member(oc, 'receptionist', 'Reception');
  accountant = await member(oc, 'accountant', 'Accountant');
});
test.after(async () => { await knex.destroy(); });

test('page catalogue: menu pages + settings sections, longest href wins, independent features are not swallowed', () => {
  const keys = access.pages().map((p) => p.key);
  for (const k of ['dashboard', 'patients', 'expenses', 'budgets', 'profit_loss', 'team', 'settings_roles', 'settings_account']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('settings_team'), 'Settings → Team is the same page as the menu item');
  assert.equal(access.pageForPath('/app/finance').key, 'profit_loss');
  assert.equal(access.pageForPath('/app/finance/assistant'), null);
  assert.equal(access.pageForPath('/app/settings/team/4/access').key, 'team');
  assert.equal(access.pageForPath('/app/settings').key, 'settings');
  assert.equal(access.pageForPath('/app').key, 'dashboard');
  assert.equal(access.pageForPath('/app/patients/12/edit').key, 'patients');
  assert.equal(access.pageForPath('/app/visits/3'), null);
});

test('allow adds the page permissions and menu item — that page only; manage level adds editing', async () => {
  const oc = await ctxOf(owner);
  let p = await perms(reception);
  assert.ok(!p.has('expenses.view'));
  assert.ok(!menuKeys(p).includes('expenses'));
  assert.equal(await access.save(oc, reception.membershipId, { expenses: { mode: 'allow' } }), 1);
  p = await perms(reception); // no manual cache clearing: save() invalidates
  assert.ok(p.has('expenses.view'));
  assert.ok(!p.has('expenses.manage'));
  assert.ok(menuKeys(p).includes('expenses'));
  assert.ok(!menuKeys(p).includes('budgets'), 'budgets also needs expenses.view but was not allowed');
  assert.ok(p.pagesOff.has('budgets'));
  assert.equal((await runGate(reception, '/budgets')).status, 403);
  assert.ok((await runGate(reception, '/expenses')).next);
  await access.save(oc, reception.membershipId, { expenses: { mode: 'allow', level: 'manage' } });
  p = await perms(reception);
  assert.ok(p.has('expenses.manage'));
});

test('deny hides the page, blocks its addresses and removes its permissions', async () => {
  const oc = await ctxOf(owner);
  await access.save(oc, reception.membershipId, { patients: { mode: 'deny' } });
  const p = await perms(reception);
  for (const x of ['patients.view', 'patients.create', 'patients.edit']) assert.ok(!p.has(x), x);
  assert.ok(p.has('appointments.view_all'), 'scope permissions are never removed');
  assert.ok(!menuKeys(p).includes('patients'));
  assert.ok(menuKeys(p).includes('appointments'));
  const g = await runGate(reception, '/patients/5');
  assert.equal(g.status, 403);
  assert.equal(g.view, 'pages/access/blocked');
  const post = await runGate(reception, '/patients', 'POST');
  assert.equal(post.status, 403);
  assert.ok((await runGate(reception, '/appointments')).next);
});

test('deny keeps permissions that another open page still needs', async () => {
  const oc = await ctxOf(owner);
  await access.save(oc, accountant.membershipId, { expenses: { mode: 'deny' } });
  const p = await perms(accountant);
  assert.ok(p.has('expenses.view'), 'Budgets still needs expenses.view');
  assert.ok(menuKeys(p).includes('budgets'));
  assert.ok(!menuKeys(p).includes('expenses'));
  assert.equal((await runGate(accountant, '/expenses')).status, 403);
  assert.ok((await runGate(accountant, '/budgets')).next);
  // Denying both removes the shared permission too.
  await access.save(oc, accountant.membershipId, { budgets: { mode: 'deny' } });
  assert.ok(!(await perms(accountant)).has('expenses.view'));
});

test('landing: a denied entry page sends the member to their first open page', async () => {
  const oc = await ctxOf(owner);
  await access.save(oc, reception.membershipId, { front_desk: { mode: 'deny' }, dashboard: { mode: 'deny' } });
  const g = await runGate(reception, '/front-desk');
  assert.ok(g.redirect && g.redirect !== '/app/front-desk', `redirected to ${g.redirect}`);
  assert.ok((await runGate(reception, '/')).redirect);
  await access.save(oc, reception.membershipId, { front_desk: { mode: 'default' }, dashboard: { mode: 'default' } });
  assert.ok((await runGate(reception, '/front-desk')).next);
});

test('core pages can\'t be denied; administration pages can\'t be allowed one by one', async () => {
  const oc = await ctxOf(owner);
  await assert.rejects(access.save(oc, reception.membershipId, { settings_account: { mode: 'deny' } }), { code: 'ACCESS_CORE' });
  await assert.rejects(access.save(oc, reception.membershipId, { support: { mode: 'deny' } }), { code: 'ACCESS_CORE' });
  await assert.rejects(access.save(oc, reception.membershipId, { team: { mode: 'allow' } }), { code: 'ACCESS_ROLE_ONLY' });
  await assert.rejects(access.save(oc, reception.membershipId, { settings_clinic: { mode: 'allow' } }), { code: 'ACCESS_ROLE_ONLY' });
});

test('the owner can never be restricted', async () => {
  const oc = await ctxOf(owner);
  const ownerM = await knex('memberships').where({ business_id: owner.businessId, user_id: owner.userId }).first('id');
  await assert.rejects(access.save(oc, ownerM.id, { patients: { mode: 'deny' } }), { code: 'ACCESS_OWNER' });
  // Even a row written directly is ignored for the owner.
  await knex('member_page_access').insert({ business_id: owner.businessId, membership_id: ownerM.id, user_id: owner.userId, page_key: 'patients', mode: 'deny' });
  rbac.invalidate(owner.businessId);
  const p = await perms(owner);
  assert.ok(p.has('patients.view'));
  assert.ok(!p.pagesOff);
  assert.ok((await runGate(owner, '/patients')).next);
  await knex('member_page_access').where({ membership_id: ownerM.id }).del();
});

test('a manager can\'t give beyond their own access, nor change themselves or the owner', async () => {
  const oc = await ctxOf(owner);
  const mc = await ctxOf(manager);
  const ownerM = await knex('memberships').where({ business_id: owner.businessId, user_id: owner.userId }).first('id');
  await assert.rejects(access.save(mc, manager.membershipId, { patients: { mode: 'deny' } }), { code: 'ACCESS_SELF' });
  await assert.rejects(access.save(mc, ownerM.id, { patients: { mode: 'deny' } }), { code: 'ACCESS_OWNER' });
  // The clinic manager role has no finance.manage: they can give Profit & loss to view, not to manage.
  await assert.rejects(access.save(mc, reception.membershipId, { profit_loss: { mode: 'allow', level: 'manage' } }), { code: 'ACCESS_BEYOND_OWN' });
  assert.equal(await access.save(mc, reception.membershipId, { profit_loss: { mode: 'allow' } }), 1);
  // Once the owner denies Reports to the manager, the manager can't give Reports to anyone.
  await access.save(oc, manager.membershipId, { reports: { mode: 'deny' } });
  const mc2 = await ctxOf(manager);
  await assert.rejects(access.save(mc2, reception.membershipId, { reports: { mode: 'allow' } }), { code: 'ACCESS_BEYOND_OWN' });
  // …while the owner can. Denying stays possible for the manager.
  assert.equal(await access.save(oc, reception.membershipId, { reports: { mode: 'allow' } }), 1);
  assert.equal(await access.save(mc2, reception.membershipId, { certificates: { mode: 'deny' } }), 1);
  // A member without users.manage can't change anything.
  await assert.rejects(access.save(await ctxOf(reception), accountant.membershipId, { patients: { mode: 'allow' } }), { code: 'PERMISSION_DENIED' });
});

test('changes are audited (who, member, page, from → to) and reset goes back to the role', async () => {
  const oc = await ctxOf(owner);
  const before = await knex('audit_logs').where({ business_id: owner.businessId, action: 'staff.page_access' }).count({ n: '*' }).first();
  await access.save(oc, reception.membershipId, { reviews: { mode: 'allow' } });
  const row = await knex('audit_logs').where({ business_id: owner.businessId, action: 'staff.page_access' }).orderBy('id', 'desc').first();
  assert.equal(row.user_id, owner.userId);
  assert.equal(String(row.entity_id), String(reception.userId));
  assert.deepEqual(pj(row.old_values), { member: 'Reception', page: 'reviews', access: 'default' });
  assert.deepEqual(pj(row.new_values), { member: 'Reception', page: 'reviews', access: 'allow' });
  const sum = await access.summaries(owner.businessId);
  assert.ok(sum[reception.membershipId].added >= 1);
  assert.ok(sum[reception.membershipId].removed >= 1);
  const n = await access.reset(oc, reception.membershipId);
  assert.ok(n >= 3);
  const after = await knex('audit_logs').where({ business_id: owner.businessId, action: 'staff.page_access' }).count({ n: '*' }).first();
  assert.ok(Number(after.n) >= Number(before.n) + 1 + n);
  const p = await perms(reception);
  assert.ok(p.has('patients.view'));
  assert.ok(!p.has('expenses.view'));
  assert.ok(!p.pagesOff);
  assert.equal(await knex('member_page_access').where({ membership_id: reception.membershipId }).count({ n: '*' }).first().then((r) => Number(r.n)), 0);
});
