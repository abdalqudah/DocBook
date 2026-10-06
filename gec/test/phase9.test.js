const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent, agent } = require('./helpers');
const { hashPassword } = require('../src/modules/auth/auth.service');

const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];
let admin; let marketing; let counsellor; let superAdmin;
test.before(async () => {
  await resetDb();
  await require('../src/db/seeds/demo-cms').run();
  admin = await makeStaff({ role: 'admin' });
  superAdmin = await makeStaff({ role: 'super_admin' });
  marketing = await makeStaff({ role: 'marketing' });
  counsellor = await makeStaff({ role: 'counsellor' });
});
test.after(() => knex.destroy());

test('public CMS: services, resources, FAQ (with JSON-LD), editable pages; unpublished content stays hidden', async () => {
  const a = await agent();
  const services = await a.get('/services');
  assert.equal(services.status, 200); assert.match(services.text, /Academic Counseling/);
  assert.doesNotMatch(services.text, /98%|2\.5M|100%/, 'unverifiable marketing claims are not imported');
  const svc = await a.get('/services/f1-visa-guidance');
  assert.equal(svc.status, 200); assert.match(svc.text, /"@type":"Service"/);
  const list = await a.get('/resources?category=visa');
  assert.match(list.text, /F-1 Student Visa Interview/); assert.doesNotMatch(list.text, /STEM OPT Explained/);
  const art = await a.get('/resources/f1-visa-complete-guide-2026');
  assert.match(art.text, /"@type":"Article"/); assert.match(art.text, /confirm with the official/);
  const faq = await a.get('/faq');
  assert.match(faq.text, /"@type":"FAQPage"/); assert.match(faq.text, /F-1 visa/);
  const visa = await a.get('/visa');
  assert.equal(visa.status, 200); assert.match(visa.text, /not legal advice/); assert.match(visa.text, /What is an F-1 Student Visa/, 'FAQs with topic "visa" appear on the page');
  const about = await a.get('/about?lang=ar');
  assert.match(about.text, /من نحن/); assert.match(about.text, /hreflang="ar"/);
  // Testimonials were imported without consent → not shown on the home page
  const home = await (await agent()).get('/');
  assert.doesNotMatch(home.text, /Omar Al-Husseini/);
  assert.match(home.text, /Academic Counseling/, 'published services appear on the home page');
  await knex('articles').where({ slug: 'stem-opt-3-year-work-explained' }).update({ is_published: false });
  assert.equal((await a.get('/resources/stem-opt-3-year-work-explained')).status, 404);
  await knex('articles').where({ slug: 'parents-guide-studying-in-usa' }).update({ published_at: new Date(Date.now() + 86400_000) });
  assert.equal((await a.get('/resources/parents-guide-studying-in-usa')).status, 404, 'future-dated articles are scheduled, not shown');
  assert.equal((await a.get('/no-such-page')).status, 404);
});

test('sitemap and robots: published content only, private areas excluded', async () => {
  const a = await agent();
  const sm = await a.get('/sitemap.xml');
  assert.equal(sm.status, 200); assert.match(sm.headers['content-type'], /xml/);
  assert.match(sm.text, /\/resources\/f1-visa-complete-guide-2026/); assert.match(sm.text, /\/services\/academic-counseling/); assert.match(sm.text, /\/about</);
  assert.doesNotMatch(sm.text, /stem-opt-3-year-work-explained/);
  assert.match(sm.text, /hreflang="ar"/);
  const rb = await a.get('/robots.txt');
  assert.match(rb.text, /Disallow: \/staff/); assert.match(rb.text, /Disallow: \/portal/); assert.match(rb.text, /Sitemap: /);
});

test('staff CMS: create & publish a page, reserved addresses refused, consent rule for testimonials, nav override, permissions', async () => {
  const m = await staffAgent(marketing);
  let tok = await m.token();
  const r = await m.post('/staff/pages').type('form').send({ _csrf: tok, title_en: 'Our offices', title_ar: 'مكاتبنا', slug: 'offices', body_en: '## Amman\nOpen Sunday to Thursday.', is_published: '1', show_cta: '1' });
  assert.equal(r.status, 302);
  const pub = await (await agent()).get('/offices');
  assert.equal(pub.status, 200); assert.match(pub.text, /<h2>Amman<\/h2>/);
  await m.post('/staff/pages').type('form').send({ _csrf: tok, title_en: 'Hijack', slug: 'staff', is_published: '1' });
  assert.equal(await knex('pages').where({ slug: 'staff' }).first(), undefined);
  // Body is escaped (no raw HTML)
  await m.post('/staff/pages').type('form').send({ _csrf: tok, title_en: 'XSS', slug: 'xss-test', body_en: '<script>alert(1)</script> [x](javascript:alert(1))', is_published: '1' });
  const x = await (await agent()).get('/xss-test');
  assert.doesNotMatch(x.text, /<script>alert/); assert.doesNotMatch(x.text, /href="javascript:/);
  // Testimonial without consent cannot be published
  const t = await knex('testimonials').first();
  tok = await m.token();
  await m.post(`/staff/testimonials/${t.id}`).type('form').send({ _csrf: tok, name_en: t.name_en, quote_en: t.quote_en, is_published: '1' });
  assert.equal((await knex('testimonials').where({ id: t.id }).first()).is_published, 0);
  const ok = await m.post(`/staff/testimonials/${t.id}`).type('form').send({ _csrf: tok, name_en: t.name_en, quote_en: t.quote_en, is_published: '1', consent_on_file: '1' });
  assert.equal(ok.status, 302, (ok.text.match(/class="(?:field-error|alert[^"]*)"[^]{0,300}/g) || []).join('\n') || ok.text.slice(-3000));
  assert.match((await (await agent()).get('/')).text, new RegExp(t.name_en));
  // Navigation override: one active header link replaces the built-in menu
  await m.post('/staff/navigation').type('form').send({ _csrf: tok, label_en: 'Our offices', label_ar: 'مكاتبنا', href: '/offices', location: 'header', is_active: '1', position: '1' });
  const nav = await (await agent()).get('/services');
  assert.match(nav.text, /<a href="\/offices"[^>]*>Our offices<\/a>/); assert.doesNotMatch(nav.text, /<li class=""><a href="\/universities">/);
  await m.post('/staff/navigation').type('form').send({ _csrf: tok, label_en: 'Bad', href: 'javascript:alert(1)', location: 'header', is_active: '1' });
  assert.equal(await knex('nav_items').where({ label_en: 'Bad' }).first(), undefined, 'unsafe links refused');
  await knex('nav_items').del(); require('../src/modules/cms/nav').clear();
  // Home page texts
  await m.post('/staff/website/home').type('form').send({ _csrf: tok, hero_title_en: 'Plan your studies abroad', hero_title_ar: '' });
  const home = await (await agent()).get('/');
  assert.match(home.text, /Plan your studies abroad/);
  assert.match((await (await agent()).get('/?lang=ar')).text, /ماذا تود أن تدرس/, 'empty Arabic field falls back to the default text');
  // A counsellor cannot edit the website
  const c = await staffAgent(counsellor);
  assert.equal((await c.get('/staff/pages')).status, 403);
  // Every change is audited
  assert.ok(await knex('audit_logs').where({ entity_type: 'page' }).first());
});

test('privacy: public request → verify → export → anonymize; retention removes old website history', async () => {
  const [uid] = await knex('users').insert({ kind: 'student', email: 'lina@example.com', name: 'Lina Odeh', password_hash: await hashPassword('StudentPass123!'), status: 'active', email_verified_at: new Date() });
  const [sid] = await knex('students').insert({ ref: 'S-PRIV01', first_name: 'Lina', last_name: 'Odeh', email: 'lina@example.com', phone: '+962790000000', user_id: uid });
  const stageId = (await knex('lead_stages').orderBy('id').first()).id;
  const [lid] = await knex('leads').insert({ stage_id: stageId, ref: 'L-PRIV01', first_name: 'Lina', last_name: 'Odeh', email: 'lina@example.com', student_id: sid, source: 'website' });
  await knex('notes').insert({ student_id: sid, body: 'Private note', author_id: (await knex('users').where({ kind: 'staff' }).first()).id }).catch(() => {});
  const [inv] = await knex('invoices').insert({ number: 'INV-P-1', student_id: sid, bill_to_name: 'Lina Odeh', bill_to_email: 'lina@example.com', currency: 'USD', total: 500, subtotal: 500, status: 'paid', issue_date: new Date(), public_token: 'tok-priv-1' }).catch(() => [null]);

  const pub = await agent();
  const page = await pub.get('/privacy');
  const sent = await pub.post('/privacy/request').type('form').send({ _csrf: csrfOf(page.text), name: 'Lina Odeh', email: 'lina@example.com', type: 'delete', details: 'Please delete my data' });
  assert.equal(sent.status, 302); assert.match(sent.headers.location, /sent=1/);
  const req = await knex('privacy_requests').orderBy('id', 'desc').first();
  assert.equal(req.identity_verified, 0, 'anonymous requests are not trusted');
  assert.ok(await knex('notifications').where({ category: 'privacy' }).first(), 'privacy handlers are notified');

  // Admin (without privacy.manage) cannot act; super admin can
  assert.equal((await (await staffAgent(admin)).get(`/staff/privacy/${req.id}`)).status, 403);
  const s = await staffAgent(superAdmin);
  const view = await s.get(`/staff/privacy/${req.id}`);
  assert.equal(view.status, 200); assert.match(view.text, /S-PRIV01/, 'matching student suggested');
  const tok = await s.token();
  // Nothing happens before identity is verified
  await s.post(`/staff/privacy/${req.id}/anonymize`).type('form').send({ _csrf: tok, confirm: 'DELETE', student_id: String(sid) });
  assert.equal((await knex('students').where({ id: sid }).first()).anonymized_at, null, 'nothing happens before identity is verified');
  await s.post(`/staff/privacy/${req.id}`).type('form').send({ _csrf: tok, student_id: String(sid), identity_verified: '1', status: 'verifying' });
  const exp = await s.get(`/staff/privacy/${req.id}/export`);
  assert.equal(exp.status, 200); assert.match(exp.headers['content-disposition'], /attachment/);
  const data = JSON.parse(exp.text);
  assert.equal(data.student.email, 'lina@example.com'); assert.equal(data.student.passport_enc, undefined); assert.ok(Array.isArray(data.leads));
  await s.post(`/staff/privacy/${req.id}/anonymize`).type('form').send({ _csrf: tok, confirm: 'delete it' });
  assert.equal((await knex('students').where({ id: sid }).first()).anonymized_at, null, 'typed confirmation required');
  const done = await s.post(`/staff/privacy/${req.id}/anonymize`).type('form').send({ _csrf: tok, confirm: 'DELETE' });
  assert.equal(done.status, 302);
  const st = await knex('students').where({ id: sid }).first();
  assert.equal(st.email, null); assert.equal(st.phone, null); assert.equal(st.first_name, 'Deleted'); assert.ok(st.anonymized_at);
  assert.equal((await knex('leads').where({ id: lid }).first()).email, null);
  const u = await knex('users').where({ id: uid }).first();
  assert.equal(u.status, 'disabled'); assert.equal(u.password_hash, null);
  if (inv) { const i = await knex('invoices').where({ id: inv }).first(); assert.equal(i.bill_to_name, 'Deleted'); assert.equal(Number(i.total), 500, 'financial records keep amounts'); }
  assert.equal((await knex('privacy_requests').where({ id: req.id }).first()).status, 'done');
  assert.ok(await knex('audit_logs').where({ action: 'privacy.anonymized', entity_id: sid }).first());
  // Former student can no longer sign in
  const lg = await agent(); const lp = await lg.get('/login');
  const signin = await lg.post('/login').type('form').send({ _csrf: csrfOf(lp.text), email: 'lina@example.com', password: 'StudentPass123!' });
  assert.notEqual(signin.headers.location, '/portal');

  // Retention: old anonymous website history is removed, recent kept
  const svc = require('../src/modules/privacy/service');
  const old = new Date(Date.now() - 40 * 30 * 86400_000);
  const v1 = 'old-visitor-000000000000'; const v2 = 'new-visitor-000000000000';
  await knex('visitors').insert([{ id: v1, first_seen_at: old, last_seen_at: old }, { id: v2, first_seen_at: new Date(), last_seen_at: new Date() }]);
  await knex('tracking_events').insert([{ visitor_id: v1, name: 'pageview', path: '/', created_at: old }, { visitor_id: v2, name: 'pageview', path: '/', created_at: new Date() }]);
  const r = await svc.applyRetention();
  assert.ok(r.events >= 1 && r.visitors >= 1);
  assert.equal(await knex('visitors').where({ id: v1 }).first(), undefined);
  assert.ok(await knex('visitors').where({ id: v2 }).first());

  // Stale leads can be anonymised in bulk
  const [stale] = await knex('leads').insert({ stage_id: stageId, ref: 'L-STALE1', first_name: 'Old', email: 'old@example.com', source: 'website', created_at: old, last_activity_at: old });
  const tok2 = await s.token();
  assert.match((await s.get('/staff/privacy/stale')).text, /L-STALE1/);
  await s.post('/staff/privacy/stale').type('form').send({ _csrf: tok2, lead_id: String(stale) });
  assert.equal((await knex('leads').where({ id: stale }).first()).email, null);
});

test('portal: a signed-in student can ask for deletion (identity already verified)', async () => {
  const [uid] = await knex('users').insert({ kind: 'student', email: 'omar@example.com', name: 'Omar K', password_hash: await hashPassword('StudentPass123!'), status: 'active', email_verified_at: new Date() });
  const [sid] = await knex('students').insert({ ref: 'S-PRIV02', first_name: 'Omar', email: 'omar@example.com', user_id: uid });
  const a = await agent(); const lp = await a.get('/login');
  const li = await a.post('/login').type('form').send({ _csrf: csrfOf(lp.text), email: 'omar@example.com', password: 'StudentPass123!' });
  assert.equal(li.status, 302);
  const set = await a.get('/portal/settings');
  assert.equal(set.status, 200);
  const r = await a.post('/portal/settings/delete-request').type('form').send({ _csrf: csrfOf(set.text), details: 'Close my account' });
  assert.equal(r.status, 302);
  const pr = await knex('privacy_requests').where({ student_id: sid }).first();
  assert.equal(pr.type, 'delete'); assert.equal(pr.identity_verified, 1);
});
