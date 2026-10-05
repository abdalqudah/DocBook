// One medical centre on its own domain: the website's addresses are short — /about, /services, /doctors, /book —
// every link in the pages is written that way, and the old long ones (/<address>/p/about…) redirect to them.
process.env.NODE_ENV = 'test';
process.env.APP_EDITION = 'center';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const centers = require('../src/modules/center/center.service');
const rbac = require('../src/modules/rbac/rbac.service');
const { mainSlug } = require('../src/middleware/edition');
const { serve } = require('./_http');
const { publishSite } = require('./_clean-site');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let app; let slug;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Centre owner', email: `ecu-${tag}@t.test`, password: 'Passw0rd!x' }));
  let row = await knex('businesses').whereNot('status', 'deleted').where({ kind: 'center_admin' }).whereNotNull('slug').orderBy('id').first('id', 'slug');
  if (!row) {
    const id = await knex.transaction(async (trx) => {
      const b = await businesses.create(uid, { name: 'مركز الروابط', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
      await centers.create({ businessId: b, userId: uid }, { name: 'مركز الروابط' }, trx);
      await trx('businesses').where({ id: b }).update({ kind: 'center_admin', onboarding_completed_at: new Date() });
      return b;
    });
    row = await knex('businesses').where({ id }).first('id', 'slug');
  } else {
    await knex('memberships').insert({ business_id: row.id, user_id: uid, role_id: (await rbac.getRoleByKey(row.id, 'owner')).id });
    rbac.invalidate(row.id);
  }
  await publishSite(row.id, uid, tag);
  cache.forgetPrefix('');
  slug = await mainSlug();
  assert.equal(slug, row.slug);
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('short addresses on the centre\'s domain; links written short; old addresses redirect', async () => {
  const v = app.agent();
  const home = await v.get('/');
  assert.equal(home.status, 200);
  for (const href of ['/about', '/services', '/doctors', '/book']) assert.match(home.text, new RegExp(`href="${href}"`), href);
  assert.doesNotMatch(home.text, new RegExp(`href="/${slug}(/(p|book|doctors|articles)\\b|")`), 'no long link left');
  assert.doesNotMatch(home.text, /#s-a0c0000102"/, 'the doctors menu link is the doctors page');
  for (const [p, text] of [['/about', `about ${tag}`], ['/services', `services ${tag}`]]) {
    const r = await v.get(p);
    assert.equal(r.status, 200, p);
    assert.ok(r.text.includes(text), p);
  }
  const docs = await v.get('/doctors');
  assert.equal(docs.status, 200);
  assert.match(docs.text, /<title>الأطباء · /);
  assert.match(docs.text, /rel="canonical" href="[^"]*\/doctors\?lang=ar"/);
  assert.equal((await v.get('/book')).status, 200);
  // old addresses → the short ones, permanently
  for (const [from, to] of [[`/${slug}/p/about`, '/about'], [`/${slug}/p/services?lang=en`, '/services?lang=en'], [`/${slug}/book`, '/book'], [`/${slug}/doctors`, '/doctors']]) {
    const r = await v.get(from);
    assert.equal(r.status, 301, from);
    assert.equal(r.location, to, from);
  }
  // the system's own addresses are untouched
  assert.equal((await v.get('/app')).status, 302);
  assert.equal((await v.get('/login')).status, 200);
  assert.equal((await v.get('/no-such-page')).status, 404);
});
