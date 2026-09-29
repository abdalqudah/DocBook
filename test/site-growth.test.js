// Landing-page media library and section design, Search & AI (SEO/AEO/GEO), social links and
// consent-gated measurement pixels — against a real database (docbook_test) through HTTP.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const media = require('../src/modules/site/media.service');
const seo = require('../src/modules/site/seo.service');

let server; let base; let clinicSlug;

/** A small real PNG (RGB) of the given size. */
function png(w, h) {
  const crcT = []; for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 90);
  for (let y = 0; y < h; y += 1) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Cookie + CSRF aware client. */
function client() {
  const jar = {};
  let csrf = '';
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => { for (const h of res.headers.getSetCookie()) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } };
  const read = async (res) => { store(res); const text = await res.text(); const m = text.match(/name="csrf-token" content="([^"]+)"/); if (m) csrf = m[1]; return { status: res.status, location: res.headers.get('location'), csp: res.headers.get('content-security-policy') || '', headers: res.headers, text }; };
  return {
    jar,
    get csrf() { return csrf; },
    get: async (path) => read(await fetch(base + path, { headers: { cookie: cookie() }, redirect: 'manual' })),
    post: async (path, data = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...data })) [].concat(v).forEach((x) => body.append(k, x));
      return read(await fetch(base + path, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' }));
    },
    upload: async (buf, type, name) => {
      const res = await fetch(`${base}/admin/site/media`, { method: 'POST', body: buf, headers: { cookie: cookie(), 'content-type': type, 'x-csrf-token': csrf, 'x-file-name': encodeURIComponent(name), accept: 'application/json' } });
      return { status: res.status, body: await res.json() };
    },
  };
}
const ld = (html) => [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map((m) => JSON.parse(m[1]));

let admin;
test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const adminId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Platform Admin', email: 'root@growth.test', password: 'Passw0rd!x' }));
  await knex('users').where({ id: adminId }).update({ is_platform_admin: true });
  // A clinic that finished set-up and takes online bookings, with a doctor.
  const ownerId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: 'owner@growth.test', password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Growth Clinic', currency: 'JOD', timezone: 'Asia/Amman', city: 'Amman', country: 'JO' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: ownerId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({
    slug: 'growth-clinic', booking_enabled: true, onboarding_completed_at: new Date(), phone: '+962 6 555 0000', address: 'Mecca Street 10', working_hours_text: 'Sat–Thu 09:00–17:00',
  });
  businesses.forget(businessId);
  clinicSlug = 'growth-clinic';
  const ctx = { businessId, userId: ownerId, permissions: await rbac.getUserPermissions(businessId, ownerId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null };
  await doctors.saveDoctor(ctx, null, { full_name: 'Dr. Rana', specialization: 'Family medicine', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });

  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = client();
  await admin.get('/login');
  const r = await admin.post('/login', { email: 'root@growth.test', password: 'Passw0rd!x' });
  assert.equal(r.status, 302);
  await admin.get('/admin/site/media');
});
test.after(async () => { server.close(); await knex.destroy(); });

test('media: only real PNG/JPEG/WebP (content-checked), size read, served with safe headers', async () => {
  assert.equal(media.sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')), null);
  assert.equal(media.sniff(png(4, 3)), 'image/png');
  assert.deepEqual(media.dimensions(png(40, 30), 'image/png'), { width: 40, height: 30 });

  const svg = await admin.upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'), 'image/png', 'x.png');
  assert.equal(svg.status, 422);
  const big = await admin.upload(Buffer.alloc(media.MAX_BYTES + 10, 1), 'image/png', 'big.png');
  assert.equal(big.status, 422);
  assert.equal((await knex('site_media').count({ n: '*' }))[0].n, 0);

  const ok = await admin.upload(png(1200, 630), 'image/png', 'Share image.png');
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.name, 'Share image');
  assert.equal(ok.body.data.width, 1200);
  const file = await fetch(base + ok.body.data.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.match(file.headers.get('cache-control'), /immutable/);
  assert.match(file.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await fetch(base + ok.body.data.url.replace(/\/[a-f0-9]{16}\./, '/0000000000000000.'))).status, 404);

  // No token → refused
  const noToken = await fetch(`${base}/admin/site/media`, { method: 'POST', body: png(2, 2), headers: { 'content-type': 'image/png' } });
  assert.notEqual(noToken.status, 201);
  // Signed out → sign-in; a clinic owner (not a platform admin) → 404
  assert.equal((await client().get('/admin/site/media')).status, 302);
  const owner = client();
  await owner.get('/login');
  await owner.post('/login', { email: 'owner@growth.test', password: 'Passw0rd!x' });
  assert.equal((await owner.get('/admin/site/media')).status, 404);

  const audits = await knex('audit_logs').where({ action: 'platform.site_media_uploaded' });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].business_id, null);
  assert.equal((await admin.get('/admin/site/media')).status, 200);
});

test('sections: alignment, background and images render on the landing page', async () => {
  const [img] = await media.list();
  const content = await require('../src/modules/site/content.service').get(); // eslint-disable-line global-require
  const faq = content.sections.find((s) => s.type === 'faq');
  const hero = content.sections.find((s) => s.type === 'hero');
  const features = content.sections.find((s) => s.type === 'features');
  const bi = (v) => ({ ar: v.ar, en: v.en });
  let r = await admin.post(`/admin/site/sections/${faq.id}`, {
    f_title_ar: bi(faq.data.title).ar, f_title_en: bi(faq.data.title).en, items__q_ar: ['سؤال'], items__q_en: ['Question?'], items__a_ar: ['جواب'], items__a_en: ['Answer.'], anchor: 'faq',
    d_align: 'center', d_background: 'image', d_bg_image: String(img.id), d_media: String(img.id), d_media_pos: 'end', d_media_size: 'large', d_media_alt_en: 'Front desk', d_media_alt_ar: 'الاستقبال',
  });
  assert.equal(r.status, 302);
  r = await admin.post(`/admin/site/sections/${hero.id}`, { f_title_en: 'Hero', f_title_ar: 'البطل', f_visual: 'image', d_media: String(img.id), d_align: 'default', d_background: 'muted', anchor: 'top' });
  assert.equal(r.status, 302);
  r = await admin.post(`/admin/site/sections/${features.id}`, { f_title_en: 'Features', items__title_en: ['One'], items__title_ar: ['واحد'], items__icon: ['calendar-plus'], items__image: [String(img.id)], d_media: 'javascript:alert(1)', anchor: 'features' });
  assert.equal(r.status, 302);

  const home = (await client().get('/?lang=en')).text;
  assert.match(home, /class="section alt lp-faq al-center sec-has-bg"/);
  assert.match(home, /<div class="sec-bg" aria-hidden="true" style="background-image:url\('\/assets\/media\/\d+\/[a-f0-9]{16}\.png'\)">/);
  assert.match(home, /class="sec-split media-end"/);
  assert.match(home, /alt="Front desk" width="1200" height="630"/);
  assert.match(home, /lp-hero sec-muted/);
  assert.match(home, /lp-hero-visual lp-hero-image/);
  assert.match(home, /class="card-media"/);
  const saved = (await require('../src/modules/site/content.service').get()).sections.find((s) => s.type === 'features'); // eslint-disable-line global-require
  assert.equal(saved.design.media, '', 'only numeric media ids are stored');
});

test('SEO: validation, head tags, JSON-LD for DocBook and the clinic page, audit', async () => {
  const [img] = await media.list();
  const body = {
    site_name_ar: 'DocBook', site_name_en: 'DocBook', title_ar: 'دوك بوك للعيادات', title_en: 'DocBook for clinics', description_ar: 'وصف', description_en: 'Online booking and clinic management in Arabic and English.',
    base_url: 'https://docbook.example', og_image: String(img.id), x_handle: '@docbook', v_google: 'abc123_XYZ', o_email: 'hello@docbook.example', o_country: 'jo',
    index_home: '1', index_clinics: '1', b_gptbot: '1', b_claudebot: '1', disallow: '/private', llms: '',
  };
  let r = await admin.post('/admin/seo', { ...body, base_url: 'javascript:alert(1)', o_email: 'nope', disallow: 'no-slash' });
  assert.equal(r.status, 422);
  assert.match(r.text, /field-error/);
  r = await admin.post('/admin/seo', body);
  assert.equal(r.status, 302);

  const home = (await client().get('/?lang=en')).text;
  assert.match(home, /<title>DocBook for clinics<\/title>/);
  assert.match(home, /<link rel="canonical" href="https:\/\/docbook\.example\/\?lang=en">/);
  assert.match(home, /hreflang="ar" href="https:\/\/docbook\.example\/\?lang=ar"/);
  assert.match(home, /<meta property="og:image" content="https:\/\/docbook\.example\/assets\/media\/\d+\/[a-f0-9]{16}\.png">/);
  assert.match(home, /<meta name="google-site-verification" content="abc123_XYZ">/);
  assert.match(home, /<meta name="twitter:site" content="@docbook">/);
  const types = ld(home).map((d) => d['@type']);
  for (const t of ['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage']) assert.ok(types.includes(t), t);
  assert.equal(ld(home).find((d) => d['@type'] === 'Organization').contactPoint[0].email, 'hello@docbook.example');
  assert.equal(ld(home).find((d) => d['@type'] === 'FAQPage').mainEntity[0].name, 'Question?');

  const page = (await client().get(`/${clinicSlug}?lang=en`)).text;
  const clinic = ld(page).find((d) => d['@type'] === 'MedicalClinic');
  assert.ok(clinic);
  assert.equal(clinic.url, `https://docbook.example/${clinicSlug}`);
  assert.equal(clinic.telephone, '+962 6 555 0000');
  assert.equal(clinic.address.streetAddress, 'Mecca Street 10');
  assert.equal(clinic.address.addressCountry, 'JO');
  assert.equal(clinic.openingHours, 'Sat–Thu 09:00–17:00');
  assert.deepEqual(clinic.member.map((m) => [m['@type'], m.name]), [['Physician', 'Dr. Rana']]);
  assert.doesNotMatch(page, /noindex/);
  // JSON-LD cannot break out of its script tag
  assert.equal(seo.ldJson({ a: '</script><script>alert(1)</script>' }).includes('<'), false);
  // Staff sign-in and the booking confirmation are never indexed
  assert.match((await client().get(`/${clinicSlug}/login`)).text, /noindex/);

  const audit = await knex('audit_logs').where({ action: 'platform.seo_updated' }).first();
  assert.equal(audit.business_id, null);
});

test('robots.txt, sitemap.xml and llms.txt', async () => {
  const robots = (await client().get('/robots.txt')).text;
  assert.match(robots, /^User-agent: \*\nDisallow: \/app\n/);
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Disallow: \/\*\/login/);
  assert.match(robots, /Disallow: \/private/);
  assert.match(robots, /User-agent: CCBot\nDisallow: \/\n/, 'unticked AI crawler is blocked');
  assert.match(robots, /User-agent: GPTBot\n(Disallow: \/.*\n)+Allow: \//);
  assert.match(robots, /Sitemap: https:\/\/docbook\.example\/sitemap\.xml/);

  const sm = await client().get('/sitemap.xml');
  assert.match(sm.headers.get('content-type'), /application\/xml/);
  assert.match(sm.text, /<loc>https:\/\/docbook\.example\/<\/loc>/);
  assert.match(sm.text, new RegExp(`<loc>https://docbook\\.example/${clinicSlug}</loc>`));
  assert.match(sm.text, /hreflang="en"/);

  let llms = await client().get('/llms.txt');
  assert.match(llms.headers.get('content-type'), /text\/plain/);
  assert.match(llms.text, /^# DocBook/);
  assert.match(llms.text, /## Clinic pages with online booking/);
  assert.match(llms.text, new RegExp(`https://docbook\\.example/${clinicSlug}`));
  assert.match(llms.text, /### Question\?/);
  await admin.get('/admin/seo');
  await admin.post('/admin/seo', { site_name_en: 'DocBook', base_url: 'https://docbook.example', index_home: '1', index_clinics: '', llms: '# DocBook\n\nCustom summary.' });
  llms = await client().get('/llms.txt');
  assert.match(llms.text, /Custom summary\./);
  assert.doesNotMatch((await client().get('/sitemap.xml')).text, new RegExp(clinicSlug), 'clinic pages can be left out');
  assert.match((await client().get(`/${clinicSlug}`)).text, /noindex, follow/);
});

test('social links and pixels: strict IDs, consent first, marketing pages only, CSP per response', async () => {
  await admin.get('/admin/growth');
  let r = await admin.post('/admin/growth', { social_x: 'https://evil.example/docbook', pixel_meta: 'abc', pixel_ga4: 'G-1' });
  assert.equal(r.status, 422);
  r = await admin.post('/admin/growth', { social_x: 'https://x.com/docbook', social_linkedin: 'https://www.linkedin.com/company/docbook' });
  assert.equal(r.status, 302);
  let home = (await client().get('/?lang=en')).text;
  assert.match(home, /href="https:\/\/x\.com\/docbook" rel="noopener me"/);
  assert.deepEqual(ld(home).find((d) => d['@type'] === 'Organization').sameAs, ['https://x.com/docbook', 'https://www.linkedin.com/company/docbook']);
  assert.doesNotMatch(home, /data-consent-note/, 'no notice without pixels (essential cookies only)');

  r = await admin.post('/admin/growth', { social_x: 'https://x.com/docbook', pixel_ga4: 'G-ABC1234567', pixel_meta: '123456789012345' });
  assert.equal(r.status, 302);
  const audit = await knex('audit_logs').where({ action: 'platform.marketing_updated' }).orderBy('id', 'desc').first();
  assert.equal(audit.business_id, null);

  const v = client();
  let page = await v.get('/?lang=en');
  assert.match(page.text, /data-consent-note/);
  assert.doesNotMatch(page.text, /db-pixels|pixels\.js/, 'nothing loads before consent');
  assert.doesNotMatch(page.csp, /facebook|googletagmanager/);

  // Declining is remembered and keeps them off
  r = await v.post('/preferences/cookies', { choice: 'reject', back: '/' });
  assert.equal(r.location, '/');
  page = await v.get('/');
  assert.doesNotMatch(page.text, /data-consent-note|db-pixels/);

  // Accepting (only with a valid token; the redirect stays on the site)
  const forged = client();
  await forged.post('/preferences/cookies', { choice: 'accept', _csrf: 'nope' });
  assert.equal(forged.jar.db_consent, undefined);
  r = await v.post('/preferences/cookies', { choice: 'accept', back: 'https://evil.example/' });
  assert.equal(r.location, '/');
  page = await v.get('/?lang=en');
  assert.match(page.text, /<meta name="db-pixels" content="[^"]*G-ABC1234567/);
  assert.match(page.text, /<script src="\/js\/pixels\.js/);
  assert.match(page.csp, /script-src 'self' https:\/\/www\.googletagmanager\.com https:\/\/connect\.facebook\.net/);
  assert.match((await v.get('/preferences/cookies?lang=en')).text, /Google Analytics 4/);

  // Never on clinic pages, booking, sign-in, /app or /admin — even with consent
  for (const path of [`/${clinicSlug}`, `/${clinicSlug}/book`, `/${clinicSlug}/login`, '/login', '/signup']) {
    const x = await v.get(path);
    assert.doesNotMatch(x.text, /db-pixels|pixels\.js/, path);
    assert.doesNotMatch(x.csp, /facebook|googletagmanager/, path);
  }
  admin.jar.db_consent = 'yes';
  for (const path of ['/admin', '/admin/seo', '/admin/site/preview', '/app']) {
    const x = await admin.get(path);
    assert.doesNotMatch(x.text, /db-pixels|pixels\.js/, path);
    assert.doesNotMatch(x.csp, /facebook|googletagmanager/, path);
  }
});
