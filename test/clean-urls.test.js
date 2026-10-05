// A clinic on its own connected domain (DocBook): short website addresses there (/about, /doctors, /book), links
// written short, old long addresses redirected — while on DocBook's own address the clinic keeps /<address>/….
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const domains = require('../src/modules/branding/domain.service');
const rbac = require('../src/modules/rbac/rbac.service');
const clean = require('../src/modules/site/clean-urls');
const { serve } = require('./_http');
const { publishSite } = require('./_clean-site');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const host = `clean${tag}.com`;
let app; let slug;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Owner', email: `cu-${tag}@t.test`, password: 'Passw0rd!x' }));
  const bid = await knex.transaction((trx) => businesses.create(uid, { name: 'Clean clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('businesses').where({ id: bid }).update({ onboarding_completed_at: new Date(), slug: `clean${tag}`.slice(0, 40) });
  const biz = await publishSite(bid, uid, tag);
  slug = biz.slug;
  const ctx = { businessId: bid, userId: uid, roleKey: 'owner', permissions: await rbac.getUserPermissions(bid, uid), locale: 'en', ip: '127.0.0.1' };
  await domains.save(ctx, host);
  await knex('clinic_domains').where({ business_id: bid, host }).update({ status: 'verified' });
  domains.forget(); cache.forgetPrefix('');
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('shorten: page, booking, doctors and home links; pictures and other clinics untouched', () => {
  const s = 'mq';
  assert.equal(clean.shorten('<a href="/mq/p/about">', s), '<a href="/about">');
  assert.equal(clean.shorten('<a href="/mq/book?doctor=dr-x">', s), '<a href="/book?doctor=dr-x">');
  assert.equal(clean.shorten('<a href="/mq/doctors/dr-x">', s), '<a href="/doctors/dr-x">');
  assert.equal(clean.shorten('<a href="/mq">', s), '<a href="/">');
  assert.equal(clean.shorten('<a href="/mq#s-1">', s), '<a href="/#s-1">');
  assert.equal(clean.shorten('<link href="https://mq-dental.com/mq/p/about?lang=en">', s), '<link href="https://mq-dental.com/about?lang=en">');
  assert.equal(clean.shorten('{"url":"https://x.com/mq/book"}', s), '{"url":"https://x.com/book"}');
  assert.equal(clean.shorten('<img src="/m/mq/12.webp">', s), '<img src="/m/mq/12.webp">', 'pictures keep their address');
  assert.equal(clean.shorten('<a href="/mq2/p/about">', s), '<a href="/mq2/p/about">', 'another clinic');
  assert.equal(clean.shorten('<a href="/mqx">', s), '<a href="/mqx">');
  assert.equal(clean.shorten('<link href="/mq/theme.css">', s), '<link href="/mq/theme.css">');
  assert.equal(clean.shortOf(s, '/mq/p/about'), '/about');
  assert.equal(clean.shortOf(s, '/mq/doctors/dr-x'), '/doctors/dr-x');
  assert.equal(clean.shortOf(s, '/mq/theme.css'), null);
});

test('on the clinic\'s own domain: short addresses, short links, old ones redirect', async () => {
  const v = app.agent();
  const home = await v.get('/', { host });
  assert.equal(home.status, 200);
  for (const href of ['/about', '/services', '/doctors', '/book']) assert.match(home.text, new RegExp(`href="${href}"`), href);
  assert.doesNotMatch(home.text, new RegExp(`href="(https?://[^"/]+)?/${slug}(/(p|book|doctors|articles)\\b|")`));
  let r = await v.get('/about', { host });
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(`about ${tag}`));
  assert.match(r.text, new RegExp(`rel="canonical" href="http://${host}/about`));
  assert.equal((await v.get('/services', { host })).status, 200);
  assert.equal((await v.get('/doctors', { host })).status, 200);
  assert.equal((await v.get('/book', { host })).status, 200);
  r = await v.get(`/${slug}/p/about`, { host });
  assert.equal(r.status, 301);
  assert.equal(r.location, '/about');
  assert.equal((await v.get(`/${slug}/book`, { host })).location, '/book');
  // an unknown page is not the clinic's page; system addresses go to the main address
  assert.equal((await v.get('/app', { host })).status, 302);
  const sm = await v.get('/sitemap.xml', { host });
  assert.match(sm.text, new RegExp(`<loc>http://${host}/about</loc>`));
});

test('on DocBook\'s own address the clinic keeps its /<address>/… links', async () => {
  const v = app.agent();
  const home = await v.get(`/${slug}`);
  assert.equal(home.status, 200);
  assert.match(home.text, new RegExp(`href="/${slug}/p/about"`));
  assert.match(home.text, new RegExp(`href="/${slug}/doctors"`), 'the doctors menu link is the doctors page');
  assert.equal((await v.get(`/${slug}/p/about`)).status, 200);
  assert.equal((await v.get(`/${slug}/doctors`)).status, 200);
});
