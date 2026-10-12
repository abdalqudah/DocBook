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
  // on the platform a subscription is one clinic: another branch is another clinic with its own subscription
  assert.doesNotMatch(home.text, /حتى 3 فروع/);
  assert.doesNotMatch(home.text, /\+<bdi dir="ltr">12 JOD<\/bdi>/);

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
  assert.ok(d.header.items.some((i) => i.href === '/pricing'));
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

test('/pricing is a page of its own: cards, comparison table and pricing questions', async () => {
  const r = await app.agent().get('/pricing?lang=ar');
  assert.equal(r.status, 200);
  assert.match(r.text, /<h1>/);
  assert.match(r.text, /lp-plan/);
  assert.match(r.text, /lp-compare-table/);
  assert.match(r.text, /كيف أدفع الاشتراك؟/);
  assert.doesNotMatch(r.text, /compare_link|site\.pricing\./, 'no missing translations');
  const home = await app.agent().get('/');
  assert.match(home.text, /href="\/pricing#compare"/);
  const map = await app.agent().get('/sitemap.xml');
  if (/<loc>[^<]*\/<\/loc>/.test(map.text)) assert.match(map.text, /\/pricing<\/loc>/);
});

test('platform tour, task videos and the "All features" page; the home page shows the main features only', async () => {
  const home = await admin.get('/?lang=ar');
  assert.equal(home.status, 200);
  assert.match(home.text, /data-tour/);
  assert.match(home.text, /\/img\/landing\/ar\/today\.webp/);
  assert.match(home.text, /\/img\/landing\/ar\/flow-visit\.webp/);
  assert.match(home.text, /href="\/features"/);
  const showcase = home.text.slice(home.text.indexOf('lp-showcase'), home.text.indexOf('</section>', home.text.indexOf('lp-showcase')));
  const tiles = (showcase.match(/class="lp-tile( is-wide)?"/g) || []).length;
  assert.ok(tiles > 0 && tiles <= 6, `home shows the main cards only (${tiles})`);
  const page = await admin.get('/features?lang=en');
  assert.equal(page.status, 200);
  for (const cat of ['appointments', 'records', 'surgeries', 'money', 'team', 'partners', 'website', 'data']) assert.match(page.text, new RegExp(`id="${cat}"`));
  assert.match(page.text, /\/img\/landing\/en\/surgeries\.webp/);
  assert.ok((page.text.match(/class="lp-cat-card"/g) || []).length >= 40);
  assert.doesNotMatch(page.text, />site\.d\./); // every text is translated
  assert.equal((await admin.get('/img/landing/ar/flow-surgery.webp')).status, 200);
  // An already edited page gets the tour and the videos once, and the header link points at the new page.
  const v = site.normalise({ version: 1, rev: 5, header: { items: [{ label: { ar: 'المزايا', en: 'Features' }, href: '/#features' }] }, sections: [{ id: 'h', type: 'hero', data: {} }, { id: 'f', type: 'features', data: { items: [] } }], footer: {} });
  assert.deepEqual(v.sections.map((s) => s.type), ['hero', 'tour', 'features', 'demos']);
  assert.equal(v.header.items[0].href, '/features');
  const ed = await admin.get('/admin/site');
  assert.equal(ed.status, 200);
});
