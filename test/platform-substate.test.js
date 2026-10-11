// The admin sees a clinic's subscription as it stands today: an ended trial is "expired" on the clinics list (even
// before the hourly run), the list filters by it, a warning shows while subscriptions are off, and the CRM puts a
// clinic that signs up at "trial", not "customer", until it pays.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const subs = require('../src/modules/subscriptions/subscriptions.service');
const crm = require('../src/modules/crm/crm.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `psub-${k}-${tag}@t.test`;
const sys = { businessId: null, userId: null, ip: '127.0.0.1' };
let app; let saved; let clinicId;

const setOn = (on) => subs.saveSettings(sys, { ...saved, trialDays: 30, graceDays: 7, enabled: on ? '1' : '', trialNoCard: '1' }).then(() => cache.forgetPrefix(''));

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  saved = await subs.settings();
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'Sub Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  const owner = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail('o'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: `Ended Trial ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  clinicId = (await knex('users').where({ id: owner }).first('last_business_id')).last_business_id;
  app = await serve();
});
test.after(async () => {
  await setOn(saved.enabled);
  await app.close(); await knex.destroy();
});

test('an ended trial shows as expired on the clinics list and the filter finds it', async () => {
  await setOn(true);
  const b = await businesses.get(clinicId);
  await subs.ensure(b);
  await knex('clinic_subscriptions').where({ business_id: clinicId }).update({ status: 'trialing', trial_ends_at: '2026-01-31' });
  const a = app.agent(); await a.login(mail('a'));
  const list = await a.get(`/admin/clinics?lang=en&q=${encodeURIComponent(`Ended Trial ${tag}`)}`);
  assert.equal(list.status, 200);
  assert.match(list.text, /Expired<\/span><\/a><div class="small muted">ended/);
  assert.equal((await knex('clinic_subscriptions').where({ business_id: clinicId }).first('status')).status, 'expired');
  const filtered = await a.get('/admin/clinics?lang=en&sub=expired');
  assert.match(filtered.text, new RegExp(`Ended Trial ${tag}`));
  const trials = await a.get('/admin/clinics?lang=en&sub=trialing');
  assert.doesNotMatch(trials.text, new RegExp(`Ended Trial ${tag}`));
  const home = await a.get('/admin?lang=en');
  assert.match(home.text, /\d+ subscribed · \d+ on trial · \d+ expired/);
});

test('while subscriptions are off the list says no clinic ever stops', async () => {
  await setOn(false);
  const a = app.agent(); await a.login(mail('a'));
  const list = await a.get('/admin/clinics?lang=en');
  assert.match(list.text, /Subscriptions are off\./);
  assert.doesNotMatch(list.text, /name="sub"/);
});

test('the CRM adds a clinic that signs up at "trial" until it pays', async () => {
  await knex('crm_contacts').where({ business_id: clinicId }).del();
  await crm.sync();
  assert.equal((await knex('crm_contacts').where({ business_id: clinicId }).first('stage')).stage, 'trial');
  await knex('crm_contacts').where({ business_id: clinicId }).del();
  await knex('clinic_subscriptions').where({ business_id: clinicId }).update({ status: 'active', current_period_end: '2099-01-01' });
  await crm.sync();
  assert.equal((await knex('crm_contacts').where({ business_id: clinicId }).first('stage')).stage, 'customer');
});
