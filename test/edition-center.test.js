// One medical centre on its own domain (APP_EDITION=center): the centre's website at /, its management at /admin,
// no platform admin pages, and the centre's settings carry the system's own pages for the installation's account.
process.env.NODE_ENV = 'test';
process.env.APP_EDITION = 'center';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const centers = require('../src/modules/center/center.service');
const edition = require('../src/config/edition');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = `edc-${tag}@t.test`;
let app; let admin;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  let row = await knex('businesses').whereNot('status', 'deleted').where({ kind: 'center_admin' }).whereNotNull('slug').orderBy('id').first('id', 'slug', 'name');
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Centre owner', email: mail, password: 'Passw0rd!x' }));
  await knex('users').where({ id: uid }).update({ email_verified_at: new Date(), is_platform_admin: true });
  if (!row) {
    const bid = await knex.transaction(async (trx) => {
      const id = await businesses.create(uid, { name: 'مركز الاختبار', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
      await centers.create({ businessId: id, userId: uid }, { name: 'مركز الاختبار' }, trx);
      await trx('businesses').where({ id }).update({ kind: 'center_admin', onboarding_completed_at: new Date() });
      return id;
    });
    row = await knex('businesses').where({ id: bid }).first('id', 'slug', 'name');
  } else {
    const rbac = require('../src/modules/rbac/rbac.service'); // eslint-disable-line global-require
    await knex('memberships').insert({ business_id: row.id, user_id: uid, role_id: (await rbac.getRoleByKey(row.id, 'owner')).id });
    await knex('users').where({ id: uid }).update({ last_business_id: row.id });
  }
  await knex('businesses').where({ id: row.id }).update({ status: 'active' });
  admin = row;
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('the centre\'s site at /, management at /admin, system pages in the centre\'s settings', async () => {
  const v = app.agent();
  const home = await v.get('/');
  assert.equal(home.status, 200);
  assert.ok(home.text.includes(admin.name));
  assert.equal((await v.get('/admin')).location, '/app');
  assert.equal((await v.get('/admin/updates')).location, '/app/settings');
  assert.equal((await v.get('/signup')).location, '/login');
  assert.equal(edition.siteUrl('https://c.example', { kind: 'center_admin', slug: admin.slug }), 'https://c.example');
  const o = app.agent(); await o.login(mail);
  const settings = await o.get('/app/center/settings');
  assert.equal(settings.status, 200);
  for (const href of ['/app/settings/appearance', '/app/settings/system-update', '/app/settings/login-page', '/app/settings/maintenance']) assert.ok(settings.text.includes(`href="${href}"`), href);
  for (const p of ['/app/settings/system-update', '/app/settings/login-page', '/app/settings/maintenance', '/app/settings/appearance']) assert.equal((await o.get(p)).status, 200, p);
});
