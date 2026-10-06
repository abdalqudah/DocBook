const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent, agent } = require('./helpers');

const form = async (a, url, body) => { const t = await a.token(); return a.post(url).type('form').send({ _csrf: t, ...body }); };
let marketing;
test.before(async () => { await resetDb(); await require('../src/db/seeds/demo-catalog').run(); marketing = await makeStaff({ role: 'marketing' }); });
test.after(() => knex.destroy());

test('home: built-in slides until slides are added; photos sit on an illustrated cover', async () => {
  const home = await (await agent()).get('/?lang=en');
  assert.equal(home.status, 200);
  assert.match(home.text, /class="site has-hero"/);
  assert.equal((home.text.match(/data-slide>/g) || []).length, 4, 'four built-in slides');
  assert.match(home.text, /<h1>Your future starts at the right university<\/h1>/);
  assert.match(home.text, /background-image:url\(&#39;https:\/\/images\.unsplash\.com[^&]+[^)]*\),url\(&#39;\/img\/covers\/uk\.svg&#39;\)/, 'photo first, illustration underneath');
  assert.match(home.text, /url\(&#39;\/img\/covers\/scholarship\.svg&#39;\)/);
  assert.equal((await (await agent()).get('/img/covers/uk.svg')).status, 200);
  assert.match(home.text, /class="dest-tile big"/);
});

test('Website → Home slider: staff manage slides; unsafe links refused; inactive slides hidden', async () => {
  const m = await staffAgent(marketing);
  const r = await form(m, '/staff/slides', { title_en: 'Open day in Amman', title_ar: 'يوم مفتوح في عمّان', text_en: 'Meet our counsellors', cover: 'campus', cta_label_en: 'Register', cta_href: '/events', position: '1', is_active: '1' });
  assert.equal(r.status, 302);
  await form(m, '/staff/slides', { title_en: 'Bad', cover: 'hero', cta_label_en: 'Go', cta_href: 'javascript:alert(1)', is_active: '1' });
  assert.equal(await knex('hero_slides').where({ title_en: 'Bad' }).first(), undefined);
  await form(m, '/staff/slides', { title_en: 'Hidden slide', cover: 'hero', is_active: '0' });
  const home = await (await agent()).get('/?lang=en');
  assert.match(home.text, /<h1>Open day in Amman<\/h1>/);
  assert.match(home.text, /href="\/events"/);
  assert.doesNotMatch(home.text, /Hidden slide/);
  assert.equal((home.text.match(/data-slide>/g) || []).length, 1, 'the built-in slides are replaced');
  assert.doesNotMatch(home.text, /data-prev/, 'no controls for a single slide');
  const ar = await (await agent()).get('/?lang=ar');
  assert.match(ar.text, /يوم مفتوح في عمّان/);
  const c = await staffAgent(await makeStaff({ role: 'counsellor' }));
  assert.equal((await c.get('/staff/slides')).status, 403);
});

test('destination and university pages use cover art; logos fall back to initials', async () => {
  const a = await agent();
  const d = await a.get('/study/uk?lang=en');
  assert.match(d.text, /class="site has-hero"/); assert.match(d.text, /\/img\/covers\/uk\.svg/);
  const u = await a.get('/universities/university-of-manchester-demo?lang=en');
  assert.match(u.text, /\/art\/uni\/university-of-manchester-demo\.svg/); assert.match(u.text, /\/art\/crest\/university-of-manchester-demo\.svg/);
  const list = await a.get('/programs?lang=en');
  assert.match(list.text, /class="pcard has-cover"/);
  assert.doesNotMatch(list.text, /<img src="https:\/\/images\.unsplash/, 'no broken <img> for remote logos');
});
