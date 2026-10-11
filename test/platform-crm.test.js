// The platform owner's tools: platform settings (e-mail, WhatsApp, public link), the CRM (clinics and warehouses
// added by themselves, notes, follow-ups, e-mail from the platform), who is active and from where, and countries:
// a clinic in Saudi Arabia sees the warehouses of Saudi Arabia, a Saudi rep reaches Saudi clinics.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const crm = require('../src/modules/crm/crm.service');
const market = require('../src/modules/marketplace/market.service');
const reps = require('../src/modules/marketplace/rep-visits.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `pcrm-${k}-${tag}@t.test`;
let app; let saved; let ownerId; let saBid; let joBid; let vSa; let vJo;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  saved = await knex('platform_settings').where({ key: 'platform_comms' }).first();
  ownerId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Saudi Owner', email: mail('o'), password: 'Passw0rd!x' }));
  saBid = await knex.transaction((trx) => businesses.create(ownerId, { name: `عيادة الرياض ${tag}`, currency: 'SAR', timezone: 'Asia/Riyadh' }, trx));
  await knex('businesses').where({ id: saBid }).update({ phone: '0551112222', country: 'SA', city: 'Riyadh', onboarding_completed_at: new Date(), status: 'active', rep_visits_enabled: false, rep_requests_off: false, directory_listed: true });
  const jo = await knex.transaction((trx) => auth.createUser(trx, { name: 'Jordan Owner', email: mail('j'), password: 'Passw0rd!x' }));
  joBid = await knex.transaction((trx) => businesses.create(jo, { name: `عيادة عمان ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('businesses').where({ id: joBid }).update({ country: 'JO', city: 'Amman', onboarding_completed_at: new Date(), status: 'active', rep_requests_off: false, directory_listed: true });
  await knex('users').whereIn('id', [ownerId, jo]).update({ email_verified_at: new Date() });
  [vSa] = await knex('vendors').insert({ type: 'warehouse', name: `مستودع الرياض ${tag}`, status: 'active', country: 'SA', city: 'Riyadh', email: mail('vsa'), slug: `vsa${tag}` }).catch(() => knex('vendors').insert({ type: 'warehouse', name: `مستودع الرياض ${tag}`, status: 'active', country: 'SA', city: 'Riyadh', email: mail('vsa') }));
  [vJo] = await knex('vendors').insert({ type: 'warehouse', name: `مستودع عمان ${tag}`, status: 'active', country: 'JO', city: 'Amman', email: mail('vjo'), slug: `vjo${tag}` }).catch(() => knex('vendors').insert({ type: 'warehouse', name: `مستودع عمان ${tag}`, status: 'active', country: 'JO', city: 'Amman', email: mail('vjo') }));
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  app = await serve();
});
test.after(async () => {
  await knex('platform_settings').where({ key: 'platform_comms' }).del();
  if (saved) await knex('platform_settings').insert(saved);
  await knex('crm_contacts').whereIn('business_id', [saBid, joBid]).del();
  cache.forgetPrefix('');
  require('../src/core/mailer').resetPlatformSmtp(); // eslint-disable-line global-require
  if (app) await app.close();
  await knex.destroy();
});

test('a clinic sees the warehouses of its country; a rep reaches the clinics of its country', async () => {
  const sa = await businesses.get(saBid);
  const names = (await market.vendors({ businessId: saBid }, sa, {})).map((v) => v.name);
  assert.ok(names.includes(`مستودع الرياض ${tag}`)); assert.ok(!names.includes(`مستودع عمان ${tag}`));
  const clinics = (await reps.bookableClinics({ country: 'SA' })).map((c) => c.id);
  assert.ok(clinics.includes(saBid)); assert.ok(!clinics.includes(joBid));
});

test('platform settings: e-mail and WhatsApp saved (secrets never shown), the public WhatsApp link', async () => {
  const a = app.agent(); await a.login(mail('a'));
  let page = await a.get('/admin/settings?lang=en');
  assert.equal(page.status, 200);
  let r = await a.post('/admin/settings', { _csrf: a.csrf(page.text), mail_host: 'smtp.example.com', mail_port: '587', mail_user: 'u', mail_password: 'Secret-Pass-1', mail_from_email: 'info@medworks.app', mail_from_name: 'MedWorks', wa_phone_number_id: '123456', wa_token: 'EAAG-token', wa_public_number: '962790000000', wa_public_text_ar: 'مرحبا', wa_public_button: '1', wa_default_dial: '962', geo_lookup: '1' });
  assert.equal(r.status, 302);
  page = await a.get('/admin/settings?lang=en');
  assert.doesNotMatch(page.text, /Secret-Pass-1|EAAG-token/);
  assert.match(page.text, /https:\/\/wa\.me\/962790000000\?text=/);
  const row = JSON.parse((await knex('platform_settings').where({ key: 'platform_comms' }).first('value')).value);
  assert.notEqual(row.mail.pass_enc, 'Secret-Pass-1'); assert.ok(row.mail.pass_enc);
  r = await a.post('/admin/settings', { _csrf: a.csrf(page.text), mail_host: 'not a host', mail_port: '587', mail_from_email: 'x' });
  assert.equal(r.status, 422);
  assert.equal((await knex('users').where({ email: mail('o') }).first('is_platform_admin')).is_platform_admin ? 1 : 0, 0);
  const owner = app.agent(); await owner.login(mail('o'));
  assert.equal((await owner.get('/admin/settings')).status, 404, 'platform admins only');
});

test('CRM: signed-up clinics and warehouses are added, notes and follow-ups, stage changes on the timeline', async () => {
  const a = app.agent(); await a.login(mail('a'));
  let r = await a.get('/admin/crm?lang=en');
  assert.equal(r.status, 200);
  const c = await knex('crm_contacts').where({ business_id: saBid }).first();
  assert.ok(c); assert.equal(c.country, 'SA'); assert.equal(c.kind, 'clinic'); assert.equal(c.email, mail('o'));
  assert.ok(await knex('crm_contacts').where({ vendor_id: vSa }).first('id'));
  r = await a.get(`/admin/crm?country=SA&lang=en`);
  assert.match(r.text, new RegExp(`عيادة الرياض ${tag}`)); assert.doesNotMatch(r.text, new RegExp(`عيادة عمان ${tag}`));
  const page = await a.get(`/admin/crm/${c.id}?lang=en`);
  assert.equal(page.status, 200); assert.match(page.text, /data-wa-link/);
  await a.post(`/admin/crm/${c.id}/note`, { _csrf: a.csrf(page.text), kind: 'call', body: 'Called, interested in the Riyadh branch' });
  await a.post(`/admin/crm/${c.id}/follow-up`, { _csrf: a.csrf(page.text), at: '2020-01-01', text: 'Send the offer' });
  await a.post(`/admin/crm/${c.id}/stage`, { _csrf: a.csrf(page.text), stage: 'interested' });
  const x = await crm.get(c.id);
  assert.equal(x.stage, 'interested'); assert.equal(x.next_action, 'Send the offer');
  assert.deepEqual(x.activities.map((y) => y.kind).sort(), ['call', 'stage']);
  r = await a.get('/admin/crm?due=1&lang=en');
  assert.match(r.text, new RegExp(`/admin/crm/${c.id}`), 'due follow-ups listed');
  // a new prospect by hand
  const form = await a.get('/admin/crm/new?lang=en');
  r = await a.post('/admin/crm/new', { _csrf: a.csrf(form.text), name: 'Dr Prospect', kind: 'prospect', whatsapp: '0551234567', country: 'SA', stage: 'new' });
  assert.equal(r.status, 302);
  const id = Number(r.location.split('/').pop());
  r = await a.post('/admin/crm/new', { _csrf: a.csrf(form.text), name: '' });
  assert.equal(r.status, 422);
  await a.post(`/admin/crm/${id}/delete`, { _csrf: a.csrf(form.text) });
  assert.equal(await knex('crm_contacts').where({ id }).first('id'), undefined);
});

test('who is active and from where', async () => {
  const owner = app.agent(); await owner.login(mail('o'));
  await owner.get('/app', { 'cf-ipcountry': 'SA' });
  const row = await knex('platform_activity').where({ user_id: ownerId }).first();
  assert.ok(row); assert.equal(row.country, 'SA'); assert.equal(row.kind, 'clinic');
  const a = app.agent(); await a.login(mail('a'));
  const r = await a.get('/admin/activity?period=online&lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Saudi Owner/); assert.match(r.text, /Saudi Arabia/);
});
