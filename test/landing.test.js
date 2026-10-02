// Platform home page: the pricing section built from Admin → Plans (public active plans only, "most popular"
// highlighted, prices and limits as the admin set them), the new section types in the admin editor, and the defaults.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const site = require('../src/modules/site/content.service');
const pricing = require('../src/modules/site/pricing');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let app; let admin; let savedContent; const planIds = [];

test.before(async () => {
  cache.forgetPrefix('');
  savedContent = await knex('platform_settings').where({ key: 'site_content' }).first();
  await knex('platform_settings').where({ key: 'site_content' }).del();
  const adminId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Admin', email: `lp-admin-${tag}@example.test`, password: 'Passw0rd!x' }));
  await knex('users').where({ id: adminId }).update({ is_platform_admin: true, email_verified_at: new Date() });
  app = await serve();
  admin = app.agent();
  await admin.login(`lp-admin-${tag}@example.test`);
});

test.after(async () => {
  if (planIds.length) await knex('subscription_plans').whereIn('id', planIds).del();
  await knex('platform_settings').where({ key: 'site_content' }).del();
  if (savedContent) await knex('platform_settings').insert(savedContent);
  cache.forgetPrefix('');
  if (app) await app.close();
  await knex.destroy();
});

const planForm = (name, extra = {}) => ({
  name, name_en: `${name} EN`, description: 'وصف', price_monthly: '30', price_yearly: '300', currency: 'JOD',
  max_doctors: '4', max_staff: '', max_appointments_month: '', is_active: '1', is_public: '1', sort_order: '500',
  'n_clinic.max_branches': '3', bp_extra_m: '12', 'f_ai_assistant': '1', ...extra,
});

test('the admin marks a plan as most popular; the home page lists public plans with their real prices and limits', async () => {
  let r = await admin.submit('/admin/plans/new', '/admin/plans/new', planForm(`Featured ${tag}`, { is_featured: '1' }));
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const featured = await knex('subscription_plans').where({ name: `Featured ${tag}` }).first();
  planIds.push(featured.id);
  assert.equal(Boolean(featured.is_featured), true);
  r = await admin.submit('/admin/plans/new', '/admin/plans/new', planForm(`Hidden ${tag}`, { is_public: '' }));
  assert.equal(r.status, 302);
  planIds.push((await knex('subscription_plans').where({ name: `Hidden ${tag}` }).first()).id);

  const home = await app.agent().get('/?lang=ar');
  assert.equal(home.status, 200);
  assert.match(home.text, /id="pricing"/);
  assert.match(home.text, new RegExp(`Featured ${tag}`));
  assert.doesNotMatch(home.text, new RegExp(`Hidden ${tag}`), 'hidden plans stay off the page');
  assert.match(home.text, /lp-plan is-featured/);
  assert.match(home.text, /حتى 4 أطباء/);
  assert.match(home.text, /حتى 3 فروع/);
  assert.match(home.text, /\+<bdi dir="ltr">12 JOD<\/bdi>/, 'second-branch price from the plan');

  const card = pricing.card(await require('../src/modules/subscriptions/subscriptions.service').getPlan(featured.id)); // eslint-disable-line global-require
  assert.equal(card.save, 17);
  assert.equal(card.features.find((f) => f.key === 'ai_assistant').on, true);
  assert.equal(card.features.find((f) => f.key === 'online_payments').on, false);

  // Editing the plan shows on the page at once; unchecking "most popular" removes the highlight.
  r = await admin.submit(`/admin/plans/${featured.id}`, `/admin/plans/${featured.id}`, planForm(`Featured ${tag}`, { price_monthly: '33' }));
  assert.equal(r.status, 302);
  const again = await app.agent().get('/?lang=en');
  assert.match(again.text, /<span class="lp-amount num">33<\/span>/);
  assert.equal(Boolean((await knex('subscription_plans').where({ id: featured.id }).first()).is_featured), false);
});

test('the pricing section hides itself when no plan is public', async () => {
  const saved = await knex('subscription_plans').where({ is_public: true }).select('id');
  await knex('subscription_plans').whereIn('id', saved.map((p) => p.id)).update({ is_public: false });
  try {
    const home = await app.agent().get('/');
    assert.equal(home.status, 200);
    assert.doesNotMatch(home.text, /id="pricing"/);
  } finally {
    await knex('subscription_plans').whereIn('id', saved.map((p) => p.id)).update({ is_public: true });
  }
});

test('defaults include the new sections; the admin can add and edit them', async () => {
  const d = site.defaults();
  for (const type of ['stats', 'showcase', 'pricing']) assert.ok(d.sections.some((s) => s.type === type), type);
  assert.ok(d.header.items.some((i) => i.href === '/#pricing'));
  const home = await app.agent().get('/?lang=ar');
  assert.match(home.text, /class="lp-bento"/);
  assert.match(home.text, /data-count>24\/7</);

  const r = await admin.submit('/admin/site', '/admin/site/sections', { type: 'showcase' });
  assert.equal(r.status, 302);
  const id = r.location.split('/').pop();
  const form = await admin.get(r.location);
  assert.equal(form.status, 200);
  assert.match(form.text, /items__size/);
  const saved = await admin.submit(r.location, r.location, {
    f_title_ar: 'جديدنا', f_title_en: 'Ours', items__icon: 'star', items__title_ar: 'بطاقة', items__title_en: 'Card', items__text_ar: 'نص', items__text_en: 'Text', items__tag_ar: 'جديد', items__tag_en: 'New', items__size: 'wide',
  });
  assert.equal(saved.status, 302);
  const s = (await site.get()).sections.find((x) => x.id === id);
  assert.equal(s.data.items[0].size, 'wide');
  assert.equal(s.data.items[0].tag.ar, 'جديد');
  const preview = await admin.get('/admin/site/preview');
  assert.equal(preview.status, 200);
  assert.match(preview.text, /lp-tile is-wide/);
});
