// "Add a clinic" used by mistake for a branch: the owner's other clinic becomes a branch of this one (name, address,
// phone; its doctors copied in, same-name doctors not duplicated). An empty one can be deleted with it; one with
// patients stays a separate clinic. Only an owner of both clinics may do it.
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
const mail = (k) => `bm-${k}-${tag}@t.test`;
let app; let owner; let A; let B2; let C3;

async function clinic(userId, name, extra = {}) {
  await knex.transaction((trx) => businesses.create(userId, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  const { last_business_id: id } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id }).update({ onboarding_completed_at: new Date(), ...extra });
  return id;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  owner = await knex.transaction((trx) => auth.createUser(trx, { name: 'Owner', email: mail('o'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: owner }).update({ email_verified_at: new Date() });
  A = await clinic(owner, 'MQ', { city: 'amman', phone: '0796666666' });
  B2 = await clinic(owner, 'MQ Abdali', { city: 'Amman', address: 'Abdali Boulevard', phone: '0791234567' });
  C3 = await clinic(owner, 'MQ Irbid');
  await knex('doctors').insert([
    { business_id: A, full_name: 'د. منصور', is_active: true },
    { business_id: B2, full_name: 'د. منصور', is_active: true },
    { business_id: B2, full_name: 'د. لما', is_active: true, base_salary: 900 },
  ]);
  await knex('patients').insert({ business_id: C3, full_name: 'Patient', phone: '0790000000' });
  await knex('users').where({ id: owner }).update({ last_business_id: A });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('the branches page offers the owner\'s other clinics; an empty one becomes a branch and is deleted', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const page = await o.get('/app/clinic/branches');
  assert.equal(page.status, 200);
  assert.match(page.text, /MQ Abdali/);
  assert.match(page.text, /MQ Irbid/);
  const r = await o.post('/app/clinic/branches/from-clinic', { _csrf: o.csrf(page.text), clinic_id: String(B2), remove: '1' });
  assert.equal(r.status, 302);
  const br = await knex('clinic_branches').where({ business_id: A }).first();
  assert.equal(br.name, 'MQ Abdali');
  assert.equal(br.address, 'Abdali Boulevard');
  assert.equal(br.phone, '0791234567');
  const docs = await knex('doctors').where({ business_id: A }).orderBy('id');
  assert.equal(docs.length, 2); // د. منصور not duplicated
  assert.equal(docs[1].full_name, 'د. لما');
  assert.equal(docs[1].branch_id, br.id);
  assert.equal(Number(docs[1].base_salary), 900);
  assert.equal(await knex('businesses').where({ id: B2 }).first(), undefined);
  assert.ok(await knex('audit_logs').where({ business_id: A, action: 'branch.from_clinic' }).first());
});

test('a clinic with patients is never deleted; another user\'s clinic cannot be taken', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const page = await o.get('/app/clinic/branches');
  await o.post('/app/clinic/branches/from-clinic', { _csrf: o.csrf(page.text), clinic_id: String(C3), remove: '1' });
  assert.ok(await knex('businesses').where({ id: C3 }).first());
  assert.equal(await knex('clinic_branches').where({ business_id: A, name: 'MQ Irbid' }).first(), undefined);
  // Someone else's clinic (the form's id is not trusted).
  const x = await knex.transaction((trx) => auth.createUser(trx, { name: 'X', email: mail('x'), password: 'Passw0rd!x' }));
  const X = await clinic(x, 'Not yours');
  await o.post('/app/clinic/branches/from-clinic', { _csrf: o.csrf(page.text), clinic_id: String(X), remove: '1' });
  assert.ok(await knex('businesses').where({ id: X }).first());
  assert.equal(await knex('clinic_branches').where({ business_id: A, name: 'Not yours' }).first(), undefined);
  // Without the delete option, one with patients still becomes a branch (its records stay where they are).
  await o.post('/app/clinic/branches/from-clinic', { _csrf: o.csrf(page.text), clinic_id: String(C3) });
  assert.ok(await knex('clinic_branches').where({ business_id: A, name: 'MQ Irbid' }).first());
  assert.equal(Number((await knex('patients').where({ business_id: C3 }).count({ n: '*' }))[0].n), 1);
});

test('the "add a clinic" page points to branches', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const p = await o.get('/workspaces/new');
  assert.match(p.text, /\/app\/clinic\/branches/);
});
