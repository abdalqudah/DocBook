// Doctors' articles: a doctor login writes (Arabic + English, images from the media library) and publishes on the
// clinic website and / or the main site; the main site needs the platform admin's approval; safe rendering; who may
// edit what; another clinic's images never appear; sitemaps.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const svc = require('../src/modules/articles/articles.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `ar-${k}-${tag}@t.test`;
let app; let B; let B2; let slug; let doc; let doc2; let otherImg;
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function clinic(email, name) {
  const id = await knex.transaction(async (trx) => {
    const u = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(u, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return u;
  });
  await knex('users').where({ id }).update({ email_verified_at: new Date() });
  const { last_business_id: b } = await knex('users').where({ id }).first('last_business_id');
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date(), booking_enabled: true });
  return { userId: id, b };
}
async function member(b, email, roleKey, doctorId = null) {
  const id = await knex.transaction((trx) => auth.createUser(trx, { name: email, email, password: 'Passw0rd!x' }));
  await knex('users').where({ id }).update({ last_business_id: b, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: b, user_id: id, role_id: (await rbac.getRoleByKey(b, roleKey)).id, doctor_id: doctorId });
  return id;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ({ b: B } = await clinic(mail('o'), 'عيادة المقالات'));
  ({ b: B2 } = await clinic(mail('x'), 'Other clinic'));
  ({ slug } = await knex('businesses').where({ id: B }).first('slug'));
  [doc] = await knex('doctors').insert({ business_id: B, full_name: 'د. سلمى', full_name_en: 'Dr Salma', specialization: 'أطفال', is_active: true });
  [doc2] = await knex('doctors').insert({ business_id: B, full_name: 'د. عمر', is_active: true });
  await member(B, mail('d'), 'doctor', doc);
  await member(B, mail('d2'), 'doctor', doc2);
  await member(B, mail('r'), 'receptionist');
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  [otherImg] = await knex('clinic_media').insert({ business_id: B2, name: 'x.png', mime: 'image/png', size: PNG.length, sha: 'abcdef0123456789', data: PNG, is_public: true });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('safe rendering: markup becomes HTML, anything typed is escaped, only known images', () => {
  const html = svc.render('## Title\n<script>alert(1)</script>\n**b** [x](javascript:alert(1)) [ok](https://a.example)\n[[img:7]]\n[[img:8]]', { 7: { url: '/m/c/7?v=1', alt: 'a' } });
  assert.match(html, /<h2>Title<\/h2>/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /href="https:\/\/a\.example"/);
  assert.match(html, /src="\/m\/c\/7\?v=1"/);
  assert.doesNotMatch(html, /img:8/);
});

let artId;
test('a doctor writes in both languages with an image, publishes on the site and asks for the main site', async () => {
  const d = app.agent(); await d.login(mail('d'));
  const page = await d.get('/app/articles/new');
  assert.equal(page.status, 200);
  const up = await d.upload('/app/articles/new', '/app/articles/images', {}, { files: { buffer: PNG, name: 'photo.png' } });
  assert.equal(up.status, 200);
  const img = JSON.parse(up.text).data[0];
  assert.ok(img.id);
  const r = await d.post('/app/articles', {
    _csrf: d.csrf(page.text), title: 'الحمّى عند الأطفال', title_en: 'Fever in children', excerpt: 'متى تقلق؟',
    body: `## متى تقلق؟\nإذا زادت الحرارة عن **39** درجة.\n\n[[img:${img.id}]]\n[[img:${otherImg}]]`, body_en: '## When to worry\nAbove **39** degrees.',
    category: 'children', cover_media_id: String(img.id), on_site: '1', on_platform: '1', action: 'publish', doctor_id: String(doc2),
  });
  assert.equal(r.status, 302);
  const a = await knex('articles').where({ business_id: B }).first();
  artId = a.id;
  assert.equal(a.doctor_id, doc); // a doctor login always writes as itself
  assert.equal(a.status, 'published');
  assert.equal(a.platform_status, 'pending');
  assert.equal(a.slug, 'fever-in-children');
  assert.equal(Boolean((await knex('clinic_media').where({ id: img.id }).first()).is_public), true);
  assert.ok(await knex('audit_logs').where({ business_id: B, action: 'article.published' }).first());
  // The clinic website: list, article (Arabic by default, English with ?lang=en), the doctor's page; not on the main site yet.
  const list = await app.agent().get(`/${slug}/articles`);
  assert.equal(list.status, 200);
  assert.match(list.text, /الحمّى عند الأطفال/);
  const art = await app.agent().get(`/${slug}/articles/fever-in-children`);
  assert.equal(art.status, 200);
  assert.match(art.text, /<strong>39<\/strong>/);
  assert.match(art.text, new RegExp(`/m/${slug}/${img.id}\\?v=`));
  assert.doesNotMatch(art.text, new RegExp(`/m/[a-z0-9-]+/${otherImg}\\?`));
  assert.match(art.text, /BlogPosting/);
  const en = await app.agent().get(`/${slug}/articles/fever-in-children?lang=en`);
  assert.match(en.text, /Fever in children/);
  const dp = await app.agent().get(`/${slug}/doctors/${doc}`);
  assert.match(dp.text, /fever-in-children/);
  assert.equal((await app.agent().get(`/blog/${artId}-fever-in-children`)).status, 404);
});

test('the main site shows it only after the platform admin approves; a text change asks again', async () => {
  const a = app.agent(); await a.login(mail('a'));
  const list = await a.get('/admin/articles');
  assert.equal(list.status, 200);
  assert.match(list.text, /الحمّى عند الأطفال|Fever in children/);
  let r = await a.post(`/admin/articles/${artId}/reject`, { _csrf: a.csrf(list.text), note: '' });
  assert.equal((await knex('articles').where({ id: artId }).first()).platform_status, 'pending'); // a reason is required
  r = await a.post(`/admin/articles/${artId}/approve`, { _csrf: a.csrf(list.text) });
  assert.equal(r.status, 302);
  cache.forgetPrefix('blog:');
  const blog = await app.agent().get('/blog');
  assert.equal(blog.status, 200);
  assert.match(blog.text, new RegExp(`/blog/${artId}-fever-in-children`));
  const page = await app.agent().get(`/blog/${artId}-fever-in-children`);
  assert.equal(page.status, 200);
  assert.match(page.text, /د\. سلمى/);
  assert.match(page.text, new RegExp(`href="/${slug}/book\\?doctor=${doc}"`));
  assert.equal((await app.agent().get(`/blog/${artId}-wrong-slug`)).status, 301);
  const sm = await app.agent().get('/sitemap.xml');
  if (sm.status === 200) assert.match(sm.text, /\/blog/);
  assert.ok(await knex('notifications').where({ business_id: B, type: 'article.review' }).first());
  // The doctor edits the text: back to review, off the main site until approved.
  const d = app.agent(); await d.login(mail('d'));
  const ed = await d.get(`/app/articles/${artId}`);
  await d.post(`/app/articles/${artId}`, { _csrf: d.csrf(ed.text), title: 'الحمّى عند الأطفال', title_en: 'Fever in children', body: 'نص جديد', body_en: '', on_site: '1', on_platform: '1', action: 'publish' });
  assert.equal((await knex('articles').where({ id: artId }).first()).platform_status, 'pending');
  assert.equal((await app.agent().get(`/blog/${artId}-fever-in-children`)).status, 404);
});

test('who may edit: another doctor cannot open it; reception cannot write; another clinic cannot reach it', async () => {
  const d2 = app.agent(); await d2.login(mail('d2'));
  assert.equal((await d2.get(`/app/articles/${artId}`)).status, 404);
  const r = app.agent(); await r.login(mail('r'));
  assert.equal((await r.get('/app/articles')).status, 403);
  const x = app.agent(); await x.login(mail('x'));
  assert.equal((await x.get(`/app/articles/${artId}`)).status, 404);
  // The owner (website editor) sees it and can sign an article as the clinic.
  const o = app.agent(); await o.login(mail('o'));
  const page = await o.get('/app/articles');
  assert.match(page.text, /الحمّى عند الأطفال|Fever in children/);
  const nw = await o.get('/app/articles/new');
  const refused = await o.post('/app/articles', { _csrf: o.csrf(nw.text), title: 'افتتاح فرع جديد', body: 'خبر', doctor_id: '', category: 'clinic_news', action: 'publish' });
  assert.equal(refused.status, 422); // nowhere chosen → not published (the form comes back with the reason)
  assert.equal(await knex('articles').where({ business_id: B, title: 'افتتاح فرع جديد' }).first(), undefined);
  await o.post('/app/articles', { _csrf: o.csrf(nw.text), title: 'افتتاح فرع جديد', body: 'خبر', doctor_id: '', on_site: '1', action: 'publish' });
  const pub = await knex('articles').where({ business_id: B, title: 'افتتاح فرع جديد', status: 'published' }).first();
  assert.ok(pub);
  assert.equal(pub.doctor_id, null);
  assert.equal(pub.platform_status, 'none');
});
