// The installation's own account: System update and Sign-in page inside the clinic's Settings (others get 404);
// the sign-in page shows the saved words and look; empty fields keep the built-in text.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `lp-${k}-${tag}@t.test`;
let app; let saved;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  saved = await knex.main('platform_settings').where({ key: 'login_page' }).first();
  for (const k of ['o', 'a']) {
    const id = await knex.transaction((trx) => auth.createUser(trx, { name: `U ${k}`, email: mail(k), password: 'Passw0rd!x' })); // eslint-disable-line no-await-in-loop
    await knex.transaction((trx) => businesses.create(id, { name: `عيادة ${k}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx)); // eslint-disable-line no-await-in-loop
    await knex('users').where({ id }).update({ email_verified_at: new Date(), is_platform_admin: k === 'a' }); // eslint-disable-line no-await-in-loop
    await knex('businesses').where({ created_by: id }).update({ onboarding_completed_at: new Date() }); // eslint-disable-line no-await-in-loop
  }
  app = await serve();
});
test.after(async () => {
  await knex.main('platform_settings').where({ key: 'login_page' }).del();
  if (saved) await knex.main('platform_settings').insert(saved);
  cache.forgetPrefix('');
  if (app) await app.close();
  await knex.destroy();
});

test('system update and sign-in page in the clinic settings — only for the installation\'s own account', async () => {
  const owner = app.agent(); await owner.login(mail('o'));
  const admin = app.agent(); await admin.login(mail('a'));
  assert.equal((await owner.get('/app/settings/system-update')).status, 404);
  assert.equal((await owner.get('/app/settings/login-page')).status, 404);
  assert.doesNotMatch((await owner.get('/app/settings')).text, /href="\/app\/settings\/system-update"/);
  const set = await admin.get('/app/settings');
  assert.match(set.text, /href="\/app\/settings\/system-update"/);
  const upd = await admin.get('/app/settings/system-update');
  assert.equal(upd.status, 200);
  assert.match(upd.text, /action="\/app\/settings\/system-update\/install"/);
  // A package that is not an update: refused with the reason, nothing changes.
  const r = await admin.upload('/app/settings/system-update', '/app/settings/system-update/install', { password: 'Passw0rd!x' }, { file: { buffer: Buffer.from('not a zip'), name: 'x.zip' } });
  assert.equal(r.status, 422);
});

test('the sign-in page shows the saved words and look', async () => {
  const admin = app.agent(); await admin.login(mail('a'));
  const pg = await admin.get('/app/settings/login-page');
  assert.equal(pg.status, 200);
  const r = await admin.post('/app/settings/login-page', { _csrf: admin.csrf(pg.text), style: 'color', show_points: '1', title_ar: 'مرحبًا بفريقنا', side_title_ar: 'عيادة الابتسامة', point_1_ar: 'زراعة الأسنان' });
  assert.equal(r.location, '/app/settings/login-page');
  cache.forgetPrefix('platform:login_page');
  const login = await app.agent().get('/login?lang=ar');
  assert.match(login.text, /مرحبًا بفريقنا/);
  assert.match(login.text, /عيادة الابتسامة/);
  assert.match(login.text, /زراعة الأسنان/);
  assert.match(login.text, /auth-side is-color/);
  assert.match(login.text, /حسابات دخول منفصلة/); // point 2 left empty → the built-in text
  const en = await app.agent().get('/login?lang=en');
  assert.doesNotMatch(en.text, /مرحبًا بفريقنا/); // English keeps its own (built-in) text
  // The admin previews it while signed in; the same editor is in the platform admin.
  assert.equal((await admin.get('/login?preview=1')).status, 200);
  assert.equal((await admin.get('/admin/login-page')).status, 200);
});
