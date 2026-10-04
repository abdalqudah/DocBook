// One clinic on its own domain (APP_EDITION=clinic): the clinic's website is the home page, the management sits behind
// /admin, and the many-clinics pages (sign-up, directory, pricing, reps) lead home.
process.env.NODE_ENV = 'test';
process.env.APP_EDITION = 'clinic';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const { serve } = require('./_http');

let app; let clinic;
test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  app = await serve();
  // The installation's clinic: the oldest clinic that is not part of a centre (created at first start in a real install).
  clinic = await knex('businesses').whereNot('status', 'deleted').whereNot('kind', 'center_admin').whereNull('center_id').whereNotNull('slug').orderBy('id').first('id', 'slug', 'name', 'status');
  if (!clinic) {
    const auth = require('../src/modules/auth/auth.service'); // eslint-disable-line global-require
    const businesses = require('../src/modules/businesses/business.service'); // eslint-disable-line global-require
    const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Owner', email: `ed-${Date.now()}@t.test`, password: 'Passw0rd!x' }));
    const id = await knex.transaction((trx) => businesses.create(uid, { name: 'Edition Clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
    clinic = await knex('businesses').where({ id }).first('id', 'slug', 'name', 'status');
  }
  await knex('businesses').where({ id: clinic.id }).update({ status: 'active' });
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('the clinic\'s website at /, its management at /admin, no platform pages', async () => {
  const a = app.agent();
  const home = await a.get('/');
  assert.equal(home.status, 200);
  assert.ok(home.text.includes(clinic.name), 'the clinic page');
  assert.equal((await a.get(`/${clinic.slug}`)).location, '/');
  assert.equal((await a.get('/book')).status, 200);
  assert.equal((await a.get('/admin')).location, '/app');
  assert.equal((await a.get('/app')).location, '/login');
  assert.equal((await a.get('/signup')).location, '/login');
  for (const p of ['/pricing', '/features', '/clinics', '/blog', '/vendors']) assert.equal((await a.get(p)).location, '/', p);
  const login = await a.get('/login');
  assert.equal(login.status, 200);
  assert.doesNotMatch(login.text, /href="\/signup"/);
  assert.doesNotMatch(login.text, /href="\/vendors"/);
  // Sign-up is closed even when posted directly.
  const r = await a.post('/signup', { _csrf: a.csrf(login.text), name: 'X', email: 'x@t.test', password: 'Passw0rd!x-Long', clinic_name: 'Another', terms: 'on' });
  assert.notEqual(r.location, '/app/onboarding');
  // No platform admin pages: they lead to the clinic's Settings (System update, sign-in page, maintenance live there).
  for (const p of ['/admin/updates', '/admin/maintenance', '/admin/clinics', '/admin/platform']) assert.equal((await a.get(p)).location, '/app/settings', p);
});

test('the sign-in page in the clinic\'s colours and logo', async () => {
  const before = (await knex('businesses').where({ id: clinic.id }).first('color')).color;
  await knex('businesses').where({ id: clinic.id }).update({ color: '#7A2E8C' });
  cache.forgetPrefix('');
  try {
    const login = await app.agent().get('/login');
    assert.ok(login.text.includes(`href="/${clinic.slug}/theme.css"`), 'the clinic theme');
    assert.match(login.text, /auth-side is-color/);
  } finally { await knex('businesses').where({ id: clinic.id }).update({ color: before }); cache.forgetPrefix(''); }
});

test('the installation\'s own clinic lives at the domain itself; other clinics keep /<address>', () => {
  const ed = require('../src/config/edition'); // eslint-disable-line global-require
  assert.equal(ed.siteUrl('https://mq.example/', { slug: 'mqapp', kind: 'clinic', center_id: null }), 'https://mq.example');
  assert.equal(ed.siteUrl('https://mq.example', { slug: 'doc', kind: 'clinic', center_id: 5 }), 'https://mq.example/doc');
  assert.equal(ed.isMain({ kind: 'center_admin' }), false);
});
