// Website → Connections: each clinic links its own social profiles, Google (profile, review link, verification) and
// measurement pixels; they apply to that clinic's public pages only, and pixels load only after its visitor accepts.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `cn-${k}-${tag}@t.test`;
let app; const clinics = {};

async function clinic(k) {
  const id = await knex.transaction((trx) => auth.createUser(trx, { name: `Owner ${k}`, email: mail(k), password: 'Passw0rd!x' }));
  await knex('users').where({ id }).update({ email_verified_at: new Date() });
  await knex.transaction((trx) => businesses.create(id, { name: `Conn ${k} ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  const b = (await knex('users').where({ id }).first('last_business_id')).last_business_id;
  const slug = `cn-${k}-${tag}`.slice(0, 40);
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date(), booking_enabled: true, slug });
  businesses.forget(b);
  return { id: b, slug };
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  clinics.a = await clinic('a');
  clinics.b = await clinic('b');
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('a clinic saves its own connections; wrong links and ids are refused with the reason', async () => {
  const o = app.agent(); await o.login(mail('a'));
  let r = await o.get('/app/website/marketing?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Google Search Console verification code/);
  r = await o.submit('/app/website/marketing', '/app/website/marketing', { s_instagram: 'https://evil.example/x', p_meta: 'abc' });
  assert.equal(r.status, 422);
  assert.match(r.text, /valid https link/);
  assert.match(r.text, /does not match/);
  r = await o.submit('/app/website/marketing', '/app/website/marketing', {
    s_instagram: 'https://instagram.com/conn_a', s_tiktok: 'https://www.tiktok.com/@conn_a', g_business: 'https://maps.app.goo.gl/abc123',
    v_google: '<meta name="google-site-verification" content="AbCdEf123456_-xyz" />', p_meta: '123456789012345', p_ga4: 'G-ABC1234567',
  });
  assert.equal(r.status, 302);
  const row = JSON.parse((await knex('businesses').where({ id: clinics.a.id }).first('marketing')).marketing);
  assert.equal(row.verify.google, 'AbCdEf123456_-xyz', 'the code is taken out of a pasted meta tag');
  assert.equal(row.pixels.meta, '123456789012345');
  assert.equal(row.social.tiktok, 'https://www.tiktok.com/@conn_a');
});

test("the clinic's page carries its verification and profiles; pixels only after its own visitor consent; other clinics untouched", async () => {
  const visitor = app.agent();
  let r = await visitor.get(`/${clinics.a.slug}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<meta name="google-site-verification" content="AbCdEf123456_-xyz">/);
  assert.match(r.text, /instagram\.com\/conn_a/, 'sameAs');
  assert.doesNotMatch(r.text, /name="db-pixels"/, 'no pixels before consent');
  assert.match(r.text, new RegExp(`name="scope" value="c${clinics.a.id}"`), 'the cookie notice is this clinic\'s');
  r = await visitor.submit(`/${clinics.a.slug}`, '/preferences/cookies', { choice: 'accept', scope: `c${clinics.a.id}`, back: `/${clinics.a.slug}` });
  assert.equal(r.location, `/${clinics.a.slug}`);
  r = await visitor.get(`/${clinics.a.slug}`);
  assert.match(r.text, /name="db-pixels"/);
  assert.match(r.text, /123456789012345/);
  // Another clinic: nothing of clinic A, and accepting A's notice does not accept the platform's or B's.
  r = await visitor.get(`/${clinics.b.slug}`);
  assert.doesNotMatch(r.text, /AbCdEf123456|123456789012345|conn_a/);
  assert.doesNotMatch(r.text, /name="db-pixels"/);
  r = await visitor.get(`/${clinics.a.slug}/book`);
  assert.doesNotMatch(r.text, /name="db-pixels"/, 'never on the booking page');
});
