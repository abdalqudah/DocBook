// Maintenance mode (Platform admin → Maintenance): visitors see "under maintenance" (503); staff keep working unless
// everything is closed; the platform admin always gets through and reopens the site; changes are audited.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `mnt-${k}-${tag}@t.test`;
let app; let slug; let saved;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  saved = await knex('platform_settings').where({ key: 'maintenance' }).first();
  const owner = await knex.transaction((trx) => auth.createUser(trx, { name: 'Owner', email: mail('o'), password: 'Passw0rd!x' }));
  const bid = await knex.transaction((trx) => businesses.create(owner, { name: 'عيادة الصيانة', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  slug = `mnt-${tag}`.slice(0, 40);
  await knex('businesses').where({ id: bid }).update({ slug, onboarding_completed_at: new Date() });
  await knex('users').where({ id: owner }).update({ email_verified_at: new Date() });
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  app = await serve();
});
test.after(async () => {
  await knex('platform_settings').where({ key: 'maintenance' }).del();
  if (saved) await knex('platform_settings').insert(saved);
  cache.forgetPrefix('');
  if (app) await app.close();
  await knex.destroy();
});

test('close the public site, then everything, then reopen', async () => {
  const admin = app.agent(); await admin.login(mail('a'));
  const staff = app.agent(); await staff.login(mail('o'));
  const visitor = app.agent();
  assert.equal((await visitor.get(`/${slug}`)).status, 200);
  const page = await admin.get('/admin/maintenance');
  assert.equal(page.status, 200);
  // Public site closed: visitors see the maintenance page with the message; staff and sign-in keep working.
  let r = await admin.post('/admin/maintenance', { _csrf: admin.csrf(page.text), on: '1', scope: 'site', message_ar: 'نعود الساعة الخامسة' });
  assert.equal(r.location, '/admin/maintenance');
  cache.forgetPrefix('platform:maintenance');
  r = await visitor.get(`/${slug}`);
  assert.equal(r.status, 503);
  assert.match(r.text, /نعود الساعة الخامسة/);
  assert.equal((await visitor.get('/')).status, 503);
  assert.equal((await visitor.get('/login')).status, 200);
  // The clinic's look still loads on the maintenance page: colours, logo, brand images.
  for (const p of [`/${slug}/theme.css`, `/${slug}/logo`, `/${slug}/brand/logo-dark`]) assert.notEqual((await visitor.get(p)).status, 503, p);
  assert.equal((await staff.get('/app/patients')).status, 200);
  assert.equal((await admin.get(`/${slug}`)).status, 200); // the admin sees the site to check it
  // Everything: the clinic's staff too; the admin still works.
  r = await admin.post('/admin/maintenance', { _csrf: admin.csrf(page.text), on: '1', scope: 'all' });
  cache.forgetPrefix('platform:maintenance');
  assert.equal((await staff.get('/app/patients')).status, 503);
  assert.equal((await admin.get('/admin/maintenance')).status, 200);
  // Reopen.
  await admin.post('/admin/maintenance', { _csrf: admin.csrf(page.text), scope: 'site' });
  cache.forgetPrefix('platform:maintenance');
  assert.equal((await visitor.get(`/${slug}`)).status, 200);
  assert.equal((await staff.get('/app/patients')).status, 200);
  const acts = await knex.main('audit_logs').whereIn('action', ['platform.maintenance_on', 'platform.maintenance_off']).where('created_at', '>', new Date(Date.now() - 600_000)).pluck('action');
  assert.ok(acts.includes('platform.maintenance_on') && acts.includes('platform.maintenance_off'));
  // Not for others.
  assert.equal((await staff.get('/admin/maintenance')).status, 404);
});
