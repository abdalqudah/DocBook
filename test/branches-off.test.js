// On the platform a clinic does not open branches: another branch is a new clinic with its own subscription. The
// platform admin may allow branches for one clinic; a clinic that already runs branches keeps them.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const branches = require('../src/modules/clinic/branches.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = `boff-${tag}@t.test`;
let app; let b; let ctx;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const u = await knex.transaction(async (trx) => { const id = await auth.createUser(trx, { name: 'Owner', email: mail, password: 'Passw0rd!x' }); await businesses.create(id, { name: `Off ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx); return id; });
  await knex('users').where({ id: u }).update({ email_verified_at: new Date() });
  b = (await knex('users').where({ id: u }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
  ctx = { businessId: b, userId: u, roleKey: 'owner', permissions: await rbac.getUserPermissions(b, u), locale: 'en', timezone: 'Asia/Amman', ip: '127.0.0.1' };
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('no branches on the platform unless the admin allows them; the page points to adding a clinic', async () => {
  const biz = await businesses.get(b);
  assert.equal(await branches.enabled(biz), false);
  await assert.rejects(branches.save(ctx, biz, null, { name: 'Abdali' }), (e) => e.code === 'BRANCHES_OFF');
  const o = app.agent(); await o.login(mail);
  let r = await o.get('/app/clinic/branches?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /data-branches-off/); assert.match(r.text, /href="\/workspaces\/new"/);
  r = await o.submit('/app/clinic/branches', '/app/clinic/branches', { name: 'Abdali' });
  assert.notEqual(r.status, 302);
  assert.equal((await knex('clinic_branches').where({ business_id: b })).length, 0);
  // the platform admin allows them for this clinic (MQ)
  await knex('businesses').where({ id: b }).update({ branches_allowed: true }); businesses.forget(b);
  assert.equal(await branches.enabled(await businesses.get(b)), true);
  await branches.save(ctx, await businesses.get(b), null, { name: 'Abdali' });
  // turned off again: the branches already there stay usable
  await knex('businesses').where({ id: b }).update({ branches_allowed: false }); businesses.forget(b); branches.forget(b);
  assert.equal(await branches.enabled(await businesses.get(b)), true, 'a clinic with branches keeps them');
});
