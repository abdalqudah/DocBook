// The CRM pipeline board (a column per stage, a card moved by drag or its menu, saved as JSON), the platform's WhatsApp
// button on its own pages (not on a clinic's), and every platform setting gathered under Admin → Settings.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `pboard-${k}-${tag}@t.test`;
let app; let saved; let contactId;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  saved = await knex('platform_settings').where({ key: 'platform_comms' }).first();
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'Board Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  [contactId] = await knex('crm_contacts').insert({ kind: 'prospect', name: `Board Lead ${tag}`, organization: 'Lead Clinic', country: 'JO', stage: 'new' });
  app = await serve();
});
test.after(async () => {
  await knex('crm_contacts').where({ id: contactId }).del();
  await knex('platform_settings').where({ key: 'platform_comms' }).del();
  if (saved) await knex('platform_settings').insert(saved);
  cache.forgetPrefix('');
  if (app) await app.close();
  await knex.destroy();
});

test('CRM board: a column per stage; a card moved to another stage (JSON) lands on the timeline', async () => {
  const a = app.agent(); await a.login(mail('a'));
  const page = await a.get('/admin/crm/board?lang=en');
  assert.equal(page.status, 200);
  assert.match(page.text, /data-crm-board/);
  for (const k of ['new', 'contacted', 'interested', 'demo', 'trial', 'customer', 'lost']) assert.match(page.text, new RegExp(`data-stage="${k}"`)); // eslint-disable-line no-restricted-syntax
  assert.match(page.text, new RegExp(`data-card="${contactId}"`));
  let r = await a.post(`/admin/crm/${contactId}/stage`, { _csrf: a.csrf(page.text), stage: 'demo' }, { accept: 'application/json' });
  assert.equal(r.status, 200); assert.equal(JSON.parse(r.text).ok, true);
  assert.equal((await knex('crm_contacts').where({ id: contactId }).first('stage')).stage, 'demo');
  assert.ok(await knex('crm_activities').where({ contact_id: contactId, kind: 'stage' }).first('id'));
  r = await a.post(`/admin/crm/${contactId}/stage`, { _csrf: a.csrf(page.text), stage: 'nope' }, { accept: 'application/json' });
  assert.equal(r.status, 422); assert.equal(JSON.parse(r.text).ok, false);
  const list = await a.get('/admin/crm?lang=en');
  assert.match(list.text, /data-crm-board-link/);
});

test('the WhatsApp button shows on the platform site when switched on', async () => {
  let home = await app.agent().get('/?lang=en');
  assert.doesNotMatch(home.text, /data-wa-float/);
  const a = app.agent(); await a.login(mail('a'));
  // another test file may save the same platform setting at the same moment: save, check, and once more if overwritten
  for (let i = 0; i < 3; i += 1) {
    const page = await a.get('/admin/settings?lang=en'); // eslint-disable-line no-await-in-loop
    const r = await a.post('/admin/settings', { _csrf: a.csrf(page.text), wa_public_number: '962790000000', wa_public_text_en: 'Hello MedWorks', wa_public_button: '1', wa_default_dial: '962' }); // eslint-disable-line no-await-in-loop
    assert.equal(r.status, 302);
    cache.forgetPrefix('');
    home = await app.agent().get('/?lang=en'); // eslint-disable-line no-await-in-loop
    if (/data-wa-float/.test(home.text)) break;
  }
  assert.match(home.text, /data-wa-float/);
  assert.match(home.text, /href="https:\/\/wa\.me\/962790000000\?text=Hello%20MedWorks"/);
});

test('every platform setting is under Admin → Settings, with its own menu', async () => {
  const a = app.agent(); await a.login(mail('a'));
  for (const p of ['/admin/settings', '/admin/branding', '/admin/login-page', '/admin/maintenance', '/admin/payments', '/admin/sales-profile', '/admin/clinic-types', '/admin/google', '/admin/ai', '/admin/updates', '/admin/databases', '/admin/images']) { // eslint-disable-line no-restricted-syntax
    const r = await a.get(`${p}?lang=en`); // eslint-disable-line no-await-in-loop
    assert.equal(r.status, 200, p);
    assert.match(r.text, /data-admin-settings/, p);
    assert.match(r.text, new RegExp(`href="${p}" class="active"`), `${p} marked in the settings menu`);
  }
  const crmPage = await a.get('/admin/crm?lang=en');
  assert.doesNotMatch(crmPage.text, /data-admin-settings/);
  assert.match(crmPage.text, /href="\/admin\/settings"/, 'one Settings entry in the sidebar');
  assert.doesNotMatch(crmPage.text, /href="\/admin\/branding"/);
});
