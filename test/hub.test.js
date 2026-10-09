// A DocBook on a clinic's own server linked to the platform: the platform admin's key (shown once, kept hashed), the
// installation's hello (reps then see the clinic), the reps' offers and ads read through /hub/v1 and shown in the
// installation's Marketplace and dashboard; a wrong or revoked key is refused. One process plays both sides here.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const hub = require('../src/modules/hub/hub.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
let server; let base; let businessId; let offerId; let adId;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: `hub${tag}@t.test`, password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'عيادة مرتبطة', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  ({ last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id'));
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), specialty: 'dentistry', city: `HubCity${tag}`, phone: '0790000123' });
  businesses.forget(businessId);
  const [vendorId] = await knex('vendors').insert({ type: 'rep', name: `Rep ${tag}`, email: `rep${tag}@vendor.test`, phone: '0791230000', status: 'active' });
  [offerId] = await knex('vendor_offers').insert({ vendor_id: vendorId, title: `Hub offer ${tag}`, body: 'Composite 20% off', status: 'published', published_at: new Date(), image: PNG, image_mime: 'image/png' });
  await knex('vendor_offer_specialties').insert({ offer_id: offerId, specialty: 'dentistry' });
  const today = new Date().toISOString().slice(0, 10);
  [adId] = await knex('vendor_ads').insert({ vendor_id: vendorId, offer_id: offerId, title: `Hub ad ${tag}`, status: 'approved', starts_on: today, days: 3, ends_on: today, specialties: '[]', cities: '[]' });
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await knex('hub_client').del().catch(() => {}); await knex('hub_cache').del().catch(() => {}); server.close(); await knex.destroy(); });

test('the API needs an active key', async () => {
  assert.equal((await fetch(`${base}/hub/v1/offers`)).status, 401);
  assert.equal((await fetch(`${base}/hub/v1/offers`, { headers: { authorization: 'Bearer dbh_nope-nope-nope-nope-nope-nope' } })).status, 401);
});

test('link → hello → offers and ads cached here; reps see the clinic; revoked key refused', async () => {
  const { id, key } = await hub.createLink({ userId: null }, `MQ ${tag}`);
  const row = await knex('hub_links').where({ id }).first();
  assert.notEqual(row.key_hash, key); assert.equal(row.key_hash.length, 64, 'only the hash is kept');
  // the installation side: Settings → Platform link
  const r = await hub.saveClient({ businessId, userId: null }, { hubUrl: base, key });
  assert.ok(r.offers >= 1 && r.ads >= 1);
  const seen = await knex('hub_links').where({ id }).first();
  assert.ok(seen.last_seen_at); assert.ok(seen.name);
  const offers = await hub.cached('offer');
  const mine = offers.find((o) => o.title === `Hub offer ${tag}`);
  assert.ok(mine && mine.image_mime === 'image/png' && mine.vendor.phone === '0791230000');
  assert.ok((await hub.cachedImage('offer', offerId)).data.equals(PNG));
  assert.ok((await hub.cached('ad')).some((a) => a.title === `Hub ad ${tag}`));
  // the key is stored encrypted
  assert.doesNotMatch(JSON.stringify(await knex('hub_client').first()), new RegExp(key));
  // reps see the linked clinic
  assert.ok((await hub.linkedClinics({})).some((c) => c.id === id));
  // an ad click is counted on the platform
  await hub.adClick(adId);
  assert.equal((await knex('vendor_ads').where({ id: adId }).first('clicks')).clicks, 1);
  // revoked: the next sync fails and says why
  await hub.revokeLink({ userId: null }, id);
  await assert.rejects(() => hub.sync(), (e) => e.code === 'HUB_KEY_REFUSED');
  assert.match((await hub.client()).last_error, /refused/);
  await hub.unlink({ businessId, userId: null });
  assert.equal((await hub.cached('offer')).length, 0);
});
