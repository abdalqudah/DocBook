// The starter sales kit: the service agreement templates (Arabic and English) with their placeholders filled, the
// onboarding services in the quotation catalog, and the migration adds only what is missing (it can run again).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const tpl = require('../src/modules/sales/templates.service');
const kit = require('../src/db/migrations/20261117000201_seed_contract_and_quote_kit');

test.before(async () => { await knex.migrate.latest(); });
test.after(async () => { await knex.destroy(); });

test('the agreement templates exist in both languages with the expected placeholders', async () => {
  const ar = await knex('document_templates').where({ name: 'اتفاقية اشتراك في الخدمة' }).first();
  const en = await knex('document_templates').where({ name: 'Service subscription agreement' }).first();
  assert.ok(ar && en);
  assert.equal(ar.locale, 'ar');
  for (const f of ['seller_name', 'company_name', 'customer_name', 'plan', 'price', 'start_date']) assert.ok(tpl.fieldsOf(ar.body).includes(f), f); // eslint-disable-line no-restricted-syntax
  assert.match(en.body, /30 days/);
});

test('the onboarding services are in the catalog and running the seed again adds nothing', async () => {
  assert.ok(await knex('sales_services').where({ name_en: 'Setup and team training' }).first('id'));
  const before = [(await knex('sales_services').count({ n: '*' }))[0].n, (await knex('document_templates').count({ n: '*' }))[0].n];
  await kit.up(knex);
  const after = [(await knex('sales_services').count({ n: '*' }))[0].n, (await knex('document_templates').count({ n: '*' }))[0].n];
  assert.deepEqual(after.map(Number), before.map(Number));
});

test('the plans are Basic 35, Advanced 50 and Business 80, the trial 14 days, and the quotation services follow', async () => {
  const plans = await knex('subscription_plans').whereIn('name_en', ['Basic', 'Advanced', 'Business']).orderBy('price_monthly').select('name', 'name_en', 'price_monthly', 'price_yearly');
  assert.deepEqual(plans.map((p) => [p.name, Number(p.price_monthly), Number(p.price_yearly)]), [['أساسي', 35, 350], ['متقدم', 50, 500], ['الأعمال', 80, 800]]);
  assert.equal(await knex('subscription_plans').whereIn('name_en', ['Starter', 'Growth', 'Network']).first('id'), undefined);
  assert.equal(require('../src/modules/subscriptions/subscriptions.service').DEFAULTS.trialDays, 14); // eslint-disable-line global-require
  const svc = await knex('sales_services').where({ name_ar: 'الباقة المتقدمة — اشتراك شهري' }).first('price');
  assert.equal(Number(svc.price), 50);
});
