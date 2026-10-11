// A clinic anywhere: sign-up with any country (its time zone and currency), the country's warehouses only; a country
// page for any country; quotations with their own title and number, and the seller's numbering (prefix, start).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const options = require('../src/modules/settings/options');
const market = require('../src/modules/marketplace/market.service');
const cpages = require('../src/modules/countrypages/countrypages.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `pworld-${k}-${tag}@t.test`;
let app; let savedProfile; let savedPages;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  savedProfile = await knex('platform_settings').where({ key: 'sales_profile' }).first();
  savedPages = await knex('platform_settings').where({ key: cpages.KEY }).first();
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'World Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  app = await serve();
});
test.after(async () => {
  for (const [k, row] of [['sales_profile', savedProfile], [cpages.KEY, savedPages]]) { // eslint-disable-line no-restricted-syntax
    await knex('platform_settings').where({ key: k }).del(); // eslint-disable-line no-await-in-loop
    if (row) await knex('platform_settings').insert(row); // eslint-disable-line no-await-in-loop
  }
  await knex('quotes').where('customer_name', 'like', `%${tag}%`).del();
  cache.forgetPrefix('');
  if (app) await app.close();
  await knex.destroy();
});

test('a clinic in Spain: any country at sign-up, its zone and currency; it sees the warehouses of Spain only', async () => {
  assert.ok(options.COUNTRIES.includes('ES') && options.COUNTRIES.includes('BR'));
  assert.deepEqual(options.geoOf('ES'), { zone: 'Europe/Madrid', currency: 'EUR' });
  assert.ok(options.ZONE_IDS.includes('America/Sao_Paulo'));
  const v = app.agent();
  const page = await v.get('/signup?lang=en');
  assert.match(page.text, /<option value="ES" data-zone="Europe\/Madrid" data-currency="EUR"/);
  const r = await v.post('/signup', { _csrf: v.csrf(page.text), name: 'Doctor Madrid', email: mail('es'), password: 'Passw0rd!x7', clinic_name: `Clínica ${tag}`, country: 'ES', currency: 'EUR', timezone: 'Europe/Madrid', terms: 'on' });
  assert.equal(r.status, 302);
  const b = await knex('businesses').where({ name: `Clínica ${tag}` }).first();
  assert.equal(b.country, 'ES'); assert.equal(b.timezone, 'Europe/Madrid'); assert.equal(b.currency, 'EUR');
  const [vEs] = await knex('vendors').insert({ type: 'warehouse', name: `Almacén ${tag}`, status: 'active', country: 'ES', email: mail('ves') });
  const [vJo] = await knex('vendors').insert({ type: 'warehouse', name: `مستودع ${tag}`, status: 'active', country: 'JO', email: mail('vjo') });
  const names = (await market.vendors({ businessId: b.id }, await businesses.get(b.id), {})).map((x) => x.name);
  assert.ok(names.includes(`Almacén ${tag}`)); assert.ok(!names.includes(`مستودع ${tag}`));
  await knex('vendors').whereIn('id', [vEs, vJo]).del();
});

test('a country page for any country: added from the list, off until switched on', async () => {
  await knex('platform_settings').where({ key: cpages.KEY }).del(); cache.forgetPrefix('');
  const a = app.agent(); await a.login(mail('a'));
  let form = await a.get('/admin/country-pages?lang=en');
  assert.doesNotMatch(form.text, /name="BR_rate"/);
  await a.post('/admin/country-pages', { _csrf: a.csrf(form.text), add_country: 'BR' });
  cache.forgetPrefix('');
  form = await a.get('/admin/country-pages?lang=en');
  assert.match(form.text, /name="BR_currency" value="BRL"/);
  assert.equal((await app.agent().get('/in/br')).status, 404);
  await a.post('/admin/country-pages', { _csrf: a.csrf(form.text), BR_on: '1', BR_currency: 'BRL', BR_rate: '7.1', BR_title_en: `Clinics in Brazil ${tag}` });
  cache.forgetPrefix('');
  const pg = await app.agent().get('/in/br?lang=en');
  assert.equal(pg.status, 200); assert.match(pg.text, new RegExp(`Clinics in Brazil ${tag}`));
});

test('a quotation with its own title and number; the seller\'s prefix and starting number', async () => {
  const a = app.agent(); await a.login(mail('a'));
  let page = await a.get('/admin/sales-profile?lang=en');
  let r = await a.post('/admin/sales-profile', { _csrf: a.csrf(page.text), quote_prefix: 'MW-{YYYY}/', quote_start: '100', tax_rate: '16', valid_days: '30', currency: 'JOD', rate_add: 'ES', rate_add_tax: '21', rate_add_currency: 'EUR' });
  assert.equal(r.status, 302);
  cache.forgetPrefix('');
  const prof = await require('../src/modules/sales/sales.service').profile(); // eslint-disable-line global-require
  assert.deepEqual(prof.country_rates.ES, { tax: 21, currency: 'EUR' });
  page = await a.get('/admin/quotes/new?lang=en');
  assert.match(page.text, /data-quote-title/);
  const lines = (csrf, extra = []) => [['_csrf', csrf], ['customer_name', `Client ${tag}`], ['item_description', 'Pro'], ['item_quantity', '1'], ['item_price', '10'], ...extra];
  r = await a.post('/admin/quotes/new', lines(a.csrf(page.text), [['title', 'Pro plan for Al Noor']]));
  const id1 = Number(r.location.split('/').pop());
  const q1 = await knex('quotes').where({ id: id1 }).first();
  const y = new Date().getUTCFullYear();
  assert.equal(q1.number, `MW-${y}/0100`); assert.equal(q1.title, 'Pro plan for Al Noor');
  r = await a.post('/admin/quotes/new', lines(a.csrf(page.text)));
  assert.equal((await knex('quotes').where({ id: Number(r.location.split('/').pop()) }).first('number')).number, `MW-${y}/0101`);
  // the team's own number; a taken one is refused
  r = await a.post('/admin/quotes/new', lines(a.csrf(page.text), [['number', `CUSTOM-${tag}`.slice(0, 40)]]));
  assert.equal(r.status, 302);
  r = await a.post('/admin/quotes/new', lines(a.csrf(page.text), [['number', `CUSTOM-${tag}`.slice(0, 40)]]));
  assert.equal(r.status, 422);
  // renamed and renumbered later
  const form = await a.get(`/admin/quotes/${id1}/edit?lang=en`);
  r = await a.post(`/admin/quotes/${id1}/edit`, lines(a.csrf(form.text), [['title', 'Pro plan — 2 branches'], ['number', `MW-${tag}`.slice(0, 40)]]));
  assert.equal(r.status, 302);
  const q = await knex('quotes').where({ id: id1 }).first();
  assert.equal(q.title, 'Pro plan — 2 branches'); assert.equal(q.number, `MW-${tag}`.slice(0, 40));
  const show = await a.get(`/admin/quotes/${id1}?lang=en`);
  assert.match(show.text, /Pro plan — 2 branches/);
  const list = await a.get('/admin/quotes?lang=en');
  assert.match(list.text, /Pro plan — 2 branches/);
});
