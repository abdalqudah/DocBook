// A rep of the platform books a visit at a clinic linked to it (its own server), live: the clinic's free times are
// read at once, the booking lands in the clinic's own rep visits (a local stand-in for the rep), the clinic's decision
// reaches the rep's list on the platform, and the rep can cancel. A new offer shows on the clinic without waiting.
// One process plays both sides here.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const tenant = require('../src/db/tenant');
const auth = require('../src/modules/auth/auth.service');
const scheduling = require('../src/modules/clinic/scheduling');
const hub = require('../src/modules/hub/hub.service');
const rv = require('../src/modules/marketplace/rep-visits.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = `hv-rep-${tag}@t.test`;
let app; let base; let own; let before; let vendorId; let linkId;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  delete process.env.APP_URL;
  const repUser = await knex.transaction((trx) => auth.createUser(trx, { name: 'Rep Hala', email: mail, password: 'Passw0rd!x' }));
  await knex('users').where({ id: repUser }).update({ email_verified_at: new Date() });
  [vendorId] = await knex('vendors').insert({ type: 'rep', name: `HubRep ${tag}`, email: `hv-v-${tag}@vendor.test`, phone: '0791110000', status: 'active', approved_at: new Date() });
  await knex('vendor_users').insert({ vendor_id: vendorId, user_id: repUser, role: 'owner' });
  app = await serve();
  base = `http://127.0.0.1:${app.server.address().port}`;
  // the installation's clinic (the first active one here) takes rep visits at fixed times, every day
  own = await hub.ownClinic();
  before = await knex('businesses').where({ id: own.id }).first('rep_visits_enabled', 'rep_visits_auto_confirm');
  await knex('businesses').where({ id: own.id }).update({ rep_visits_enabled: true, rep_visits_auto_confirm: false });
  await tenant.runFor(own.id, () => knex('rep_visit_slots').insert(DAYS.map((weekday) => ({ business_id: own.id, doctor_id: null, weekday, start_time: '08:00', end_time: '20:00', slot_minutes: 30, is_active: true }))));
  const { id, key } = await hub.createLink({ userId: null }, `MQ visits ${tag}`);
  linkId = id;
  await hub.saveClient({ businessId: own.id, userId: null }, { hubUrl: base, key, selfUrl: base });
});
test.after(async () => {
  await tenant.runFor(own.id, async () => {
    await knex('rep_visits').where({ business_id: own.id }).whereIn('vendor_id', knex('vendors').select('id').where({ hub_vendor_id: vendorId })).del();
    await knex('rep_visit_slots').where({ business_id: own.id, start_time: '08:00', end_time: '20:00', slot_minutes: 30 }).del();
  }).catch(() => {});
  await knex('businesses').where({ id: own.id }).update(before).catch(() => {});
  await knex('hub_client').del().catch(() => {}); await knex('hub_cache').del().catch(() => {});
  if (app) await app.close();
  await knex.destroy();
});

test('the platform reaches the clinic back with the secret from its hello (and only with it)', async () => {
  const l = await knex('hub_links').where({ id: linkId }).first();
  assert.equal(l.callback_url, base);
  assert.ok(l.callback_enc && !/^[a-f0-9]{48}$/.test(l.callback_enc), 'kept encrypted');
  assert.equal((await fetch(`${base}/hub-in/v1/rep/clinic`)).status, 401);
  assert.equal((await fetch(`${base}/hub-in/v1/rep/clinic`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const { clinic } = await hub.repClinic(linkId);
  assert.equal(clinic.mode, 'slots'); assert.equal(clinic.hasClinicWide, true);
});

test('a rep books live → the clinic has it → confirms → the rep sees it confirmed → cancels', async () => {
  const tomorrow = (() => { const d = new Date(`${scheduling.clinicNow('Asia/Amman').date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const rep = app.agent(); await rep.login(mail);
  let r = await rep.get('/vendor/visits/new?lang=en');
  assert.match(r.text, new RegExp(`/vendor/visits/hub/${linkId}`), 'the linked clinic can be booked');
  r = await rep.get(`/vendor/visits/hub/${linkId}?date=${tomorrow}&lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /name="visit_time" value="08:00"/, 'free times read live from the clinic');
  r = await rep.submit(`/vendor/visits/hub/${linkId}?date=${tomorrow}`, `/vendor/visits/hub/${linkId}`, { doctor_id: '', visit_date: tomorrow, visit_time: '08:30', purpose: 'New implant line' });
  assert.equal(r.status, 302); assert.equal(r.location, '/vendor/visits');
  const hv = await knex('hub_visits').where({ link_id: linkId, vendor_id: vendorId }).first();
  assert.equal(hv.status, 'requested'); assert.equal(String(hv.visit_time).slice(0, 5), '08:30');
  // on the clinic: its own rep visit, by a stand-in for the platform's rep
  const local = await tenant.runFor(own.id, () => knex('rep_visits').where({ id: hv.remote_id }).first());
  const stand = await knex('vendors').where({ id: local.vendor_id }).first();
  assert.equal(Number(stand.hub_vendor_id), vendorId); assert.equal(stand.name, `HubRep ${tag}`);
  assert.equal(local.purpose, 'New implant line');
  // the same time is no longer free
  assert.ok(!(await hub.repSlots(linkId, null, tomorrow)).some((s) => s.time === '08:30'));
  // the clinic confirms → the platform hears at once
  await tenant.runFor(own.id, () => rv.decide({ businessId: own.id, userId: null, permissions: new Set(['vendors.manage']) }, local.id, 'confirm', 'See you'));
  const after = await knex('hub_visits').where({ id: hv.id }).first();
  assert.equal(after.status, 'confirmed'); assert.equal(after.clinic_note, 'See you');
  r = await rep.get('/vendor/visits?lang=en');
  assert.match(r.text, /New implant line/);
  assert.match(r.text, new RegExp(`/vendor/visits/hub/cancel/${hv.id}`));
  // the rep cancels → the clinic's visit is cancelled too
  r = await rep.submit('/vendor/visits?lang=en', `/vendor/visits/hub/cancel/${hv.id}`, {});
  assert.equal(r.status, 302);
  assert.equal((await knex('hub_visits').where({ id: hv.id }).first()).status, 'cancelled');
  assert.equal((await tenant.runFor(own.id, () => knex('rep_visits').where({ id: local.id }).first())).status, 'cancelled');
});

test('offers are live: a new offer shows on the clinic without waiting for the hourly sync', async () => {
  await hub.cached('offer'); // warm
  const [offerId] = await knex('vendor_offers').insert({ vendor_id: vendorId, title: `Live offer ${tag}`, body: 'Now', status: 'published', published_at: new Date() });
  await knex('vendor_offer_specialties').insert({ offer_id: offerId, specialty: own.specialty || 'dentistry' }).catch(() => {});
  await knex('hub_client').update({ last_sync_at: new Date(Date.now() - 60_000) });
  const offers = await hub.cached('offer');
  assert.ok(offers.some((o) => o.title === `Live offer ${tag}`));
  await knex('vendor_offer_specialties').where({ offer_id: offerId }).del();
  await knex('vendor_offers').where({ id: offerId }).del();
});
