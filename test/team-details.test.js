// Team → edit a member: the clinic changes a member's name, e-mail and phone — but never its own (My account), an
// account shared with another clinic, someone with more access, or another owner's e-mail. Audited; a new e-mail
// must be free and is unverified until the person confirms it.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (n) => `${n}-${tag}@td.test`;
let app; let bid; let rec; let shared; let ownerUid; let managerM;

async function member(roleKey, name, b = bid) {
  const id = await knex.transaction((trx) => auth.createUser(trx, { name, email: mail(name), password: 'Passw0rd!x' }));
  await knex('users').where({ id }).update({ email_verified_at: new Date(), last_business_id: b });
  const [mid] = await knex('memberships').insert({ business_id: b, user_id: id, role_id: (await rbac.getRoleByKey(b, roleKey)).id, status: 'active' });
  rbac.invalidate(b);
  return { userId: id, membershipId: mid };
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ownerUid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Owner', email: mail('owner'), password: 'Passw0rd!x' }));
  bid = await knex.transaction((trx) => businesses.create(ownerUid, { name: 'TD clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('businesses').where({ id: bid }).update({ onboarding_completed_at: new Date() });
  await knex('users').where({ id: ownerUid }).update({ email_verified_at: new Date(), last_business_id: bid });
  rec = await member('receptionist', 'rec');
  shared = await member('nurse', 'shared');
  managerM = await member('clinic_manager', 'manager');
  // the nurse also works at another clinic
  const other = await knex.transaction((trx) => businesses.create(ownerUid, { name: 'Other clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('memberships').insert({ business_id: other, user_id: shared.userId, role_id: (await rbac.getRoleByKey(other, 'nurse')).id, status: 'active' });
  await knex('users').where({ id: ownerUid }).update({ last_business_id: bid });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

const save = async (agent, m, body) => {
  const page = await agent.get('/app/clinic/team');
  const role = await knex('memberships').where({ id: m.membershipId }).first('role_id');
  return agent.post(`/app/clinic/team/${m.membershipId}`, { _csrf: agent.csrf(page.text), details_form: '1', role_id: String(role.role_id), status: 'active', job_title: '', ...body });
};

test('the owner changes a member\'s name, e-mail and phone', async () => {
  const o = app.agent(); await o.login(mail('owner'));
  const page = await o.get('/app/clinic/team');
  assert.match(page.text, /name="email"[^>]*data-details-field|data-details-field[^>]*name="email"/);
  let r = await save(o, rec, { name: 'سارة أحمد', email: `NEW-${tag}@td.test`, phone: '+962 79 123 4567' });
  assert.equal(r.status, 302);
  const u = await knex('users').where({ id: rec.userId }).first();
  assert.equal(u.name, 'سارة أحمد');
  assert.equal(u.email, `new-${tag}@td.test`);
  assert.equal(u.phone, '+962 79 123 4567');
  assert.equal(u.email_verified_at, null, 'the new e-mail waits for its confirmation');
  assert.ok(await knex('audit_logs').where({ business_id: bid, action: 'staff.details_changed', entity_id: rec.userId }).first('id'));
  // an e-mail already used by another account
  r = await save(o, rec, { name: 'سارة أحمد', email: mail('manager') });
  assert.equal(r.status, 422);
  assert.equal((await knex('users').where({ id: rec.userId }).first('email')).email, `new-${tag}@td.test`);
});

test('shared accounts, people above you and other owners\' e-mails stay theirs', async () => {
  const o = app.agent(); await o.login(mail('owner'));
  // shared with another clinic: the posted details are not applied
  await save(o, shared, { name: 'Changed', email: `x-${tag}@td.test` });
  const s = await knex('users').where({ id: shared.userId }).first('name', 'email');
  assert.equal(s.name, 'shared');
  assert.equal(s.email, mail('shared'));
  // a manager cannot change the owner's details (the service refuses outright)
  const mctx = { businessId: bid, userId: managerM.userId, roleKey: 'clinic_manager', permissions: await rbac.getUserPermissions(bid, managerM.userId), locale: 'en', ip: '127.0.0.1' };
  const ownerM = await knex('memberships').where({ business_id: bid, user_id: ownerUid }).first('id');
  await assert.rejects(businesses.changeMemberDetails(mctx, ownerM.id, { email: `evil-${tag}@td.test` }), (e) => e.status === 403);
  assert.equal((await knex('users').where({ id: ownerUid }).first('email')).email, mail('owner'));
  // nor their own here (My account)
  await assert.rejects(businesses.changeMemberDetails(mctx, managerM.membershipId, { name: 'Me' }), (e) => e.status === 403);
  // the manager may still change a receptionist
  await businesses.changeMemberDetails(mctx, rec.membershipId, { phone: '0790000000' });
  assert.equal((await knex('users').where({ id: rec.userId }).first('phone')).phone, '0790000000');
});
