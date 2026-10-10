// Branches kept apart for supplies, purchase orders, budgets and the team room; staff with no branch work in the
// main branch; booking looks up the branch's patients only.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const supplies = require('../src/modules/clinic/supplies.service');
const purchasing = require('../src/modules/purchasing/purchasing.service');
const budgets = require('../src/modules/finance/budgets.service');
const chat = require('../src/modules/chat/chat.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `bsc-${k}-${tag}@t.test`;
let app; let b; let ctx; let branch; let main; let abd;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const u = await knex.transaction(async (trx) => { const id = await auth.createUser(trx, { name: 'Owner', email: mail('owner'), password: 'Passw0rd!x' }); await businesses.create(id, { name: `Stock ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx); return id; });
  await knex('users').where({ id: u }).update({ email_verified_at: new Date() });
  b = (await knex('users').where({ id: u }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
  [branch] = await knex('clinic_branches').insert({ business_id: b, name: `Abdali ${tag}`, is_active: true });
  ctx = { businessId: b, userId: u, roleKey: 'owner', permissions: await rbac.getUserPermissions(b, u), locale: 'en', timezone: 'Asia/Amman', currency: 'JOD', today: new Date().toISOString().slice(0, 10), ip: '127.0.0.1' };
  main = { ...ctx, workBranch: 'main' }; abd = { ...ctx, workBranch: String(branch) };
  const role = await rbac.getRoleByKey(b, 'receptionist');
  const rid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Desk', email: mail('desk'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: rid }).update({ last_business_id: b, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: b, user_id: rid, role_id: role.id });
  const [p1] = await knex('patients').insert({ business_id: b, full_name: 'Main Person', phone: '0790000001' });
  const [p2] = await knex('patients').insert({ business_id: b, full_name: 'Abdali Person', phone: '0790000002' });
  await knex('patient_branches').insert([{ business_id: b, patient_id: p1, branch_key: 'main' }, { business_id: b, patient_id: p2, branch_key: String(branch) }]);
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('each branch keeps its own stock and purchase orders', async () => {
  const sid = await supplies.saveSupplier(main, null, { name: 'Supplier', is_active: '1' });
  const a = await supplies.saveItem(main, null, { name: 'Gloves main', supplier_id: String(sid), reorder_level: '5', unit_cost: '1', current_stock: '1' });
  const c = await supplies.saveItem(abd, null, { name: 'Gloves abdali', supplier_id: String(sid), reorder_level: '5', unit_cost: '1', current_stock: '1' });
  assert.deepEqual((await supplies.items.list(main, {})).rows.map((r) => r.id), [a]);
  assert.deepEqual((await supplies.items.list(abd, {})).rows.map((r) => r.id), [c]);
  assert.equal((await supplies.items.list(ctx, {})).rows.length, 2, 'all branches');
  await assert.rejects(supplies.move(abd, a, { type: 'in', quantity: '3' }));
  const r = await purchasing.draftLowStock(abd);
  assert.equal(r.drafts.length, 1);
  const po = await purchasing.get(abd, r.drafts[0]);
  assert.equal(po.branch_key, String(branch));
  assert.deepEqual(po.lines.map((l) => l.supply_item_id), [c]);
  await assert.rejects(purchasing.get(main, po.id));
  assert.equal((await purchasing.list(main)).rows.length, 0);
});

test('budgets belong to their branch', async () => {
  await budgets.save(abd, null, { scope_key: 'supplies', monthly_limit: '100', threshold_percent: '80', is_active: '1' });
  assert.equal((await budgets.list(b, abd)).length, 1);
  assert.equal((await budgets.list(b, main)).length, 0);
  assert.equal((await budgets.list(b, ctx)).length, 0, 'whole clinic: its own budgets only');
  const ev = await budgets.evaluate(b, 'Asia/Amman', ctx.today.slice(0, 7), { ctx: abd });
  assert.equal(ev.length, 1);
});

test("the team room is the branch's own", async () => {
  const r1 = await chat.room(main); const r2 = await chat.room(abd);
  assert.notEqual(r1.id, r2.id);
  await assert.rejects(chat.access(main, r2.id));
});

test('staff with no branch work in the main branch and book its patients only', async () => {
  const d = app.agent(); await d.login(mail('desk'));
  let r = await d.get('/app/appointments/patient-lookup?q=Person');
  const names = JSON.parse(r.text).data.map((x) => x.name);
  assert.deepEqual(names, ['Main Person']);
  // choosing another branch is refused / ignored for them
  await d.submit('/app/appointments', '/workspaces/branch', { branch: String(branch) });
  r = await d.get('/app/appointments/patient-lookup?q=Person');
  assert.deepEqual(JSON.parse(r.text).data.map((x) => x.name), ['Main Person']);
});
