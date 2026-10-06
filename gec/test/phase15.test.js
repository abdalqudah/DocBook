const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent, agent } = require('./helpers');

const form = async (a, url, body) => { const t = await a.token(); return a.post(url).type('form').send({ _csrf: t, ...body }); };
let marketing;
test.before(async () => { await resetDb(); await require('../src/db/seeds/demo-catalog').run(); marketing = await makeStaff({ role: 'marketing' }); });
test.after(() => knex.destroy());

test('robots.txt: private areas closed; AI answer engines allowed, training crawlers blocked by default; staff can change it', async () => {
  const v = await agent();
  let r = await v.get('/robots.txt');
  assert.match(r.text, /User-agent: \*\nDisallow: \/staff/);
  assert.match(r.text, /Disallow: \/partner/);
  assert.match(r.text, /User-agent: GPTBot[\s\S]*?Disallow: \/\n/);
  assert.match(r.text, /User-agent: OAI-SearchBot[\s\S]*?Disallow: \/portal[\s\S]*?Allow: \//);
  assert.match(r.text, /Sitemap: .*\/sitemap\.xml/);

  const m = await staffAgent(marketing);
  await form(m, '/staff/settings/seo', { description_en: 'Study abroad advice for students in Jordan and the Gulf.', description_ar: 'استشارات الدراسة في الخارج.', google_verification: '<meta name="google-site-verification" content="abc123XYZ_-" />', bing_verification: 'BING42', ai_answers: '0', ai_training: '1', llms_enabled: '0', robots_extra: 'User-agent: BadBot\nDisallow: /\n<script>alert(1)</script>' });
  r = await v.get('/robots.txt');
  assert.match(r.text, /User-agent: OAI-SearchBot[\s\S]*?Disallow: \/\n/, 'answer engines now blocked');
  assert.doesNotMatch(r.text, /User-agent: GPTBot/, 'training allowed: no special group');
  assert.match(r.text, /User-agent: BadBot\nDisallow: \//);
  assert.doesNotMatch(r.text, /script/);
  assert.equal((await v.get('/llms.txt')).status, 404);

  const home = await v.get('/?lang=en');
  assert.match(home.text, /<meta name="google-site-verification" content="abc123XYZ_-">/);
  assert.match(home.text, /<meta name="msvalidate.01" content="BING42">/);
  const about = await v.get('/contact?lang=en');
  assert.match(about.text, /<meta name="description" content="/);
  await form(m, '/staff/settings/seo', { ai_answers: '1', ai_training: '0', llms_enabled: '1' });
});

test('llms.txt summarises the site in English and Arabic with links to live content only', async () => {
  const v = await agent();
  const en = await v.get('/llms.txt');
  assert.equal(en.status, 200);
  assert.match(en.headers['content-type'], /text\/markdown/);
  assert.match(en.text, /^# Global Education Consultants/);
  assert.match(en.text, /## Study destinations/);
  assert.match(en.text, /\/programs\/[a-z0-9-]+\)/);
  const hidden = await knex('programs').where({ is_active: true }).first();
  await knex('programs').where({ id: hidden.id }).update({ is_active: false });
  assert.doesNotMatch((await v.get('/llms.txt')).text, new RegExp(`/programs/${hidden.slug}\\)`));
  const ar = await v.get('/llms.txt?lang=ar');
  assert.match(ar.text, /## وجهات الدراسة/);
  assert.match(ar.text, /\?lang=ar\)/);
});

test('structured data: organisation + site search on home, breadcrumbs on detail pages', async () => {
  const v = await agent();
  const home = await v.get('/?lang=en');
  assert.match(home.text, /"@type":"WebSite"[\s\S]*SearchAction/);
  const u = await knex('universities').where({ is_active: true }).first();
  const page = await v.get(`/universities/${u.slug}?lang=en`);
  assert.match(page.text, /"@type":"BreadcrumbList"[^<]*"name":"Universities"/);
  assert.match(page.text, /hreflang="x-default"/);
});

test('SEO audit lists what to fix; only website/settings staff can open it', async () => {
  const m = await staffAgent(marketing);
  await knex('universities').where({ is_active: true }).limit(1).update({ name_ar: null });
  const r = await m.get('/staff/seo?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Visibility score/);
  assert.match(r.text, /without an Arabic title/);
  assert.match(r.text, /Google Search Console not verified|Bing Webmaster Tools not verified/);
  const c = await staffAgent(await makeStaff({ role: 'counsellor' }));
  assert.equal((await c.get('/staff/seo')).status, 403);
  assert.equal((await c.get('/staff/settings/seo')).status, 403);
});
