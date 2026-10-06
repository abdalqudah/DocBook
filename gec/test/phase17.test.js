const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent, agent } = require('./helpers');

const form = async (a, url, body) => { const t = await a.token(); return a.post(url).type('form').send({ _csrf: t, ...body }); };
let marketing; let pageId;
test.before(async () => {
  await resetDb(); await require('../src/db/seeds/demo-catalog').run();
  marketing = await makeStaff({ role: 'marketing' });
  [pageId] = await knex('pages').insert({ slug: 'study-in-canada-guide', title_en: 'Study in Canada', title_ar: 'الدراسة في كندا', is_published: false, show_cta: false });
});
test.after(() => knex.destroy());

test('page builder: add, edit, move, hide and remove blocks; bad links are refused', async () => {
  const m = await staffAgent(marketing);
  const url = `/staff/pages/${pageId}/builder`;
  assert.equal((await m.get(`${url}?lang=en`)).status, 200);
  await form(m, url, { op: 'add:text' });
  await form(m, url, { op: 'add:hero', 'b[0][type]': 'text', 'b[0][title_en]': 'Why Canada', 'b[0][body_en]': 'Affordable **quality** education.' });
  let blocks;
  const read = async () => { const r = (await knex('pages').where({ id: pageId }).first()).blocks; return typeof r === 'string' ? JSON.parse(r) : r; };
  blocks = await read();
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'hero']);
  // Move the hero to the top while filling it in.
  await form(m, url, { op: 'up:1', 'b[0][type]': 'text', 'b[0][title_en]': 'Why Canada', 'b[0][body_en]': 'Affordable **quality** education.', 'b[1][type]': 'hero', 'b[1][title_en]': 'Study in Canada', 'b[1][title_ar]': 'ادرس في كندا', 'b[1][cta_label_en]': 'Book', 'b[1][cta_href]': '/book' });
  blocks = await read();
  assert.deepEqual(blocks.map((b) => b.type), ['hero', 'text']);
  assert.equal(blocks[0].title_ar, 'ادرس في كندا');
  // A javascript: link is refused and nothing is saved.
  const bad = await form(m, url, { 'b[0][type]': 'hero', 'b[0][title_en]': 'X', 'b[0][cta_href]': 'javascript:alert(1)', 'b[1][type]': 'text' });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /aria-invalid/);
  assert.equal((await read())[0].title_en, 'Study in Canada');
  // Full page: hero, text, FAQ, video, a hidden block, programs.
  await form(m, url, {
    'b[0][type]': 'hero', 'b[0][title_en]': 'Study in Canada', 'b[0][title_ar]': 'ادرس في كندا', 'b[0][cta_label_en]': 'Book', 'b[0][cta_href]': '/book',
    'b[1][type]': 'text', 'b[1][title_en]': 'Why Canada', 'b[1][body_en]': 'Affordable **quality** education.',
    'b[2][type]': 'faq', 'b[2][items_en]': 'Can I work while studying? | Yes, up to 24 hours a week.\nHow long is a visa? | Usually 6–8 weeks.',
    'b[3][type]': 'video', 'b[3][url]': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'b[3][title_en]': 'Campus tour',
    'b[4][type]': 'text', 'b[4][title_en]': 'Secret draft', 'b[4][hidden]': '1',
    'b[5][type]': 'programs', 'b[5][title_en]': 'Programs in Canada', 'b[5][country]': 'CA', 'b[5][limit]': '3',
  });
  assert.equal((await read()).length, 6);
  await form(m, url, { op: 'remove:5', ...Object.fromEntries((await read()).flatMap((b, i) => Object.entries(b).filter(([k]) => k !== 'hidden' || b.hidden).map(([k, v]) => [`b[${i}][${k}]`, v === true ? '1' : String(v)]))) });
  assert.equal((await read()).length, 5);
  const c = await staffAgent(await makeStaff({ role: 'counsellor' }));
  assert.equal((await c.get(url)).status, 403);
});

test('public page renders the blocks; staff can preview before publishing', async () => {
  const v = await agent();
  assert.equal((await v.get('/study-in-canada-guide')).status, 404, 'not published');
  const m = await staffAgent(marketing);
  const pv = await m.get(`/staff/pages/${pageId}/preview?lang=en`);
  assert.equal(pv.status, 200);
  assert.match(pv.text, /class="preview-bar"/);
  await knex('pages').where({ id: pageId }).update({ is_published: true });
  const r = await v.get('/study-in-canada-guide?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /<h1 class="blk-hero-title">Study in Canada<\/h1>/);
  assert.match(r.text, /class="site has-hero"/);
  assert.match(r.text, /<strong>quality<\/strong>/);
  assert.match(r.text, /src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ"/);
  assert.doesNotMatch(r.text, /Secret draft/);
  assert.match(r.text, /"@type":"FAQPage"[^<]*Can I work while studying\?/);
  assert.match(r.headers['content-security-policy'], /frame-src https:\/\/www\.youtube-nocookie\.com/);
  const ar = await v.get('/study-in-canada-guide?lang=ar');
  assert.match(ar.text, /ادرس في كندا/);
});

test('home page sections: reorder, hide, rename, and add a page’s blocks', async () => {
  const v = await agent();
  let home = (await v.get('/?lang=en')).text;
  assert.ok(home.indexOf('dest-bento') < home.indexOf('journey-steps'), 'default order');
  const m = await staffAgent(marketing);
  const layout = await require('../src/modules/cms/home.layout').load();
  const body = { op: 'up:2' };
  layout.forEach((s, i) => { body[`s[${i}][key]`] = s.key; body[`s[${i}][visible]`] = s.key === 'testimonials' ? '0' : '1'; });
  body['s[1][title_en]'] = 'Where will you study?';
  body['s[1][title_ar]'] = 'أين ستدرس؟';
  await form(m, '/staff/website/home/sections', body);
  home = (await v.get('/?lang=en')).text;
  assert.ok(home.indexOf('journey-steps') < home.indexOf('dest-bento'), 'journey moved above destinations');
  assert.match(home, /<h2>Where will you study\?<\/h2>/);
  assert.match((await v.get('/?lang=ar')).text, /أين ستدرس؟/);
  await knex('testimonials').insert({ name_en: 'Hidden Voice', quote_en: 'Great', is_published: true }).catch(() => {});
  assert.doesNotMatch((await v.get('/?lang=en')).text, /Hidden Voice/);

  await form(m, '/staff/website/home/sections', { op: 'add_page', add_page: String(pageId), ...Object.fromEntries((await require('../src/modules/cms/home.layout').load()).flatMap((s, i) => [[`s[${i}][key]`, s.key], [`s[${i}][visible]`, s.visible ? '1' : '0']])) });
  home = (await v.get('/?lang=en')).text;
  assert.match(home, /Why Canada/);
  assert.equal((home.match(/<h1/g) || []).length, 1, 'page hero is not a second h1 on the home page');
});
