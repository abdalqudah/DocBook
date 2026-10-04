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

test('dark mode turned off for the website (even unpublished): the site and the sign-in page stay light', async () => {
  const site = require('../src/modules/website/site.service'); // eslint-disable-line global-require
  const tenant = require('../src/db/tenant'); // eslint-disable-line global-require
  const businesses = require('../src/modules/businesses/business.service'); // eslint-disable-line global-require
  const owner = await knex('memberships').where({ business_id: clinic.id }).orderBy('id').first('user_id');
  const ctx = { businessId: clinic.id, userId: owner ? owner.user_id : null };
  const b = await businesses.get(clinic.id);
  // A logo made for dark backgrounds (a white one) in the website's brand.
  const [mediaId] = await tenant.runFor(clinic.id, () => knex('clinic_media').insert({ business_id: clinic.id, name: 'white.png', folder: '', alt_ar: '', alt_en: '', mime: 'image/png', size: 4, sha: 'abc123', data: Buffer.from('x'), is_public: true, created_at: new Date(), updated_at: new Date() }));
  await tenant.runFor(clinic.id, () => site.edit(ctx, b, (d) => { d.header = { ...(d.header || {}), dark_mode: false }; d.brand = { ...(d.brand || {}), logoDarkMediaId: mediaId, faviconMediaId: mediaId }; return d; }, { note: 'website.brand_changed' }));
  cache.forgetPrefix('');
  try {
    const login = await app.agent().get('/login');
    assert.match(login.text, /<html[^>]*data-theme="light"/);
    assert.ok(login.text.includes(`/m/${clinic.slug}/${mediaId}?v=abc123`), 'the dark-background logo on the coloured side panel');
    // The website's icon is the browser icon of every page (never the built-in mark).
    for (const pg of [login, await app.agent().get("/")]) assert.ok(pg.text.includes(`<link rel="icon" href="/m/${clinic.slug}/${mediaId}?v=abc123">`), `${pg === login ? "login" : "home"}: ${(pg.text.match(/<link rel="icon"[^>]*>/) || ["none"])[0]}`);
    // The name: under the logo, or hidden (the logo alone).
    const lp = require('../src/modules/platformops/loginpage'); // eslint-disable-line global-require
    await lp.save({ businessId: null }, { style: 'color', show_points: '1', name_mode: 'below' });
    assert.match((await app.agent().get('/login')).text, /class="auth-brand is-below"/);
    await lp.save({ businessId: null }, { style: 'color', show_points: '1', name_mode: 'hidden' });
    const hid = await app.agent().get('/login');
    assert.match(hid.text, /class="auth-brand is-hidden"/);
    assert.doesNotMatch(hid.text.slice(hid.text.indexOf('auth-side'), hid.text.indexOf('<h2')), /brand-word/);
    await knex.main('platform_settings').where({ key: 'login_page' }).del();
    assert.doesNotMatch(login.text, /data-theme-toggle/);
    const home = await app.agent().get('/');
    assert.match(home.text, /<html[^>]*data-theme="light"/);
  } finally {
    await tenant.runFor(clinic.id, () => site.edit(ctx, b, (d) => { d.header = { ...(d.header || {}), dark_mode: true }; if (d.brand) { delete d.brand.logoDarkMediaId; delete d.brand.faviconMediaId; } return d; }, { note: 'website.brand_changed' }));
    await tenant.runFor(clinic.id, () => knex('clinic_media').where({ id: mediaId }).del());
    cache.forgetPrefix('');
  }
});
