// Website → Import content: a prepared .zip fills the draft (pages, menu, pictures), updates the clinic's own doctors
// matched by name (Arabic name for a Latin-only one, profile, social, photo, phone kept internal), adds the missing ones,
// keeps the previous draft as a version, never touches the live site, and refuses a file that is not a content package.
// Also: the doctor's full profile on their page and the "open a page" link of cards.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const site = require('../src/modules/website/site.service');
const importer = require('../src/modules/website/import.service');
const { ZipFile } = require('../src/core/zipstream');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const email = `imp-${tag}@t.test`;
const slug = `imp-${tag}`.slice(0, 40);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
const ABOUT = 'a0c00001f4'; const SVC = 'a0c00001f5'; const DOCS = 'a0c0000001';
let app; let ctx; let business; let mansourId; let zipPath;

async function makeZip(content, files = {}) {
  const p = path.join(os.tmpdir(), `imp-test-${tag}-${Math.random().toString(36).slice(2)}.zip`);
  const z = await ZipFile.create(p);
  await z.add('content.json', Buffer.from(JSON.stringify(content)));
  for (const [n, b] of Object.entries(files)) await z.add(n, b); // eslint-disable-line no-await-in-loop
  await z.close();
  return p;
}

const CONTENT = {
  format: 'clinic-site-content', version: 1,
  media: { 'dr-m': { file: 'images/dr-m.png', alt: { ar: 'د. منصور', en: 'Dr. Mansour' }, folder: 'team' }, team: { file: 'images/team.png' } },
  doctors: [
    { names: ['Mansour AlQudah', 'منصور القضاة'], full_name: 'د. منصور القضاة', full_name_en: 'Dr. Mansour AlQudah', specialization: 'استشاري جراحة الفم والفكين', specialization_en: 'Consultant OMFS',
      bio: 'نبذة الطبيب', bio_en: 'Doctor bio', education: 'بكالوريوس طب الأسنان\nماجستير', education_en: 'BDS\nMSc', photo: 'dr-m', phone: '+962 7 0000 0001',
      profile: { years: 25, languages: { ar: 'العربية، الإنجليزية', en: 'Arabic, English' }, focus: { ar: 'زراعة الأسنان\nخلع أضراس العقل', en: 'Implants\nWisdom teeth' }, memberships: { ar: 'عضو نقابة أطباء الأسنان', en: 'Member of the JDA' } },
      social: { instagram: 'https://instagram.com/mq', facebook: 'https://evil.example/x' } },
    { names: ['Ruba AlQudah'], full_name: 'د. ربى القضاة', full_name_en: 'Dr. Ruba AlQudah', specialization_en: 'Dentist', sort_order: 80 },
    { names: ['Not Here'], full_name: 'د. غير موجود', create: false },
  ],
  services: [{ name: 'زراعة الأسنان', name_en: 'Dental implants', items: [{ name: 'زراعة سن واحد', name_en: 'Single implant', description: 'وصف', duration: 60 }, { name: 'كشف عام', name_en: 'Check-up' }] }],
  site: {
    pages: [
      { key: 'home', sections: [
        { id: 'a0c0000002', type: 'hero', variant: 'slider', content: { ar: { headline: `مرحبا ${tag}`, slides: [{ headline: 'شريحة' }] }, en: { headline: `Welcome ${tag}` } }, settings: { slides: [{ image: '@media:team', text_mode: 'txt_follow' }] } },
        { id: 'a0c0000003', type: 'cards', variant: 'grid', content: { ar: { title: 'خدماتنا', items: [{ title: 'زراعة', text: 'نص', button: 'اعرف المزيد' }] }, en: {} }, settings: { media: 'icons', items: [{ icon: 'dt-implant', action: 'page', page: SVC }] } },
        { id: DOCS, type: 'doctors', variant: 'cards', content: { ar: { title: 'أطباؤنا' }, en: {} }, settings: { mode: 'all', show_fee: false } }] },
      { key: ABOUT, slug: 'about', title: { ar: 'من نحن', en: 'About' }, menu: true, sections: [{ id: 'a0c0000004', type: 'text', variant: 'plain', content: { ar: { title: 'من نحن', text: `عن المركز ${tag}` }, en: {} }, settings: {} }] },
      { key: SVC, slug: 'implants', title: { ar: 'زراعة الأسنان', en: 'Implants' }, menu: false, sections: [{ id: 'a0c0000005', type: 'text', variant: 'plain', content: { ar: { text: `صفحة الزراعة ${tag}` }, en: {} }, settings: {} }] },
    ],
    header: { show_name: false, items: [{ kind: 'home', label: { ar: 'الرئيسية', en: 'Home' } }, { kind: 'page', target: ABOUT, label: { ar: 'من نحن', en: 'About' } }, { kind: 'section', target: DOCS, label: { ar: 'أطباؤنا', en: 'Doctors' } }] },
    footer: { show_powered: false, contact_title: { ar: `تواصل ${tag}`, en: 'Reach us' }, contact_extra: { ar: 'فرع العبدلي — الطابق 21', en: '' } },
    seo: { title: { ar: `المركز ${tag}`, en: 'Center' } },
    brand: { logo: '@media:team' },
  },
};

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Import clinic', currency: 'JOD', timezone: 'Asia/Amman', specialty: 'dentistry' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug, booking_enabled: true });
  ctx = { businessId, userId, roleKey: 'owner', permissions: await rbac.getUserPermissions(businessId, userId), locale: 'ar', timezone: 'Asia/Amman', currency: 'JOD', ip: '127.0.0.1' };
  await knex('services').insert({ business_id: businessId, name: 'كشف عام', price: 15, duration_minutes: 30, is_active: true });
  [mansourId] = await knex('doctors').insert({ business_id: businessId, full_name: 'Dr.Mansour Alqudah', phone: null, is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()) });
  business = await knex('businesses').where({ id: businessId }).first();
  zipPath = await makeZip(CONTENT, { 'images/dr-m.png': PNG, 'images/team.png': PNG });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); try { fs.unlinkSync(zipPath); } catch { /* gone */ } await knex.destroy(); });

test('names match across Arabic / English spellings and titles', () => {
  assert.equal(importer.nameKey('Dr.Mansour Alqudah'), importer.nameKey('Mansour AlQudah'));
  assert.equal(importer.nameKey('د. لمى عاشور'), importer.nameKey('لمى عاشور'));
  assert.equal(importer.nameKey('أنس'), importer.nameKey('انس'));
  assert.deepEqual(importer.resolveRefs({ a: '@media:x', b: ['@media:x', '@media:nope'], c: 'text' }, { x: 7 }), { a: 7, b: [7], c: 'text' });
});

test('upload a content package: draft pages, doctors, pictures; live site untouched; previous draft kept', async () => {
  // Something published first: it must stay live as it was.
  await site.draft(ctx, business);
  await site.publish(ctx, business);
  const liveBefore = (await knex('clinic_sites').where({ business_id: ctx.businessId }).first()).live_version_id;
  const archivedBefore = await knex('clinic_site_versions').where({ business_id: ctx.businessId, kind: 'archived' }).count({ n: '*' }).then((r) => Number(r[0].n));
  const a = app.agent(); await a.login(email);
  const r = await a.upload('/app/website/import', '/app/website/import', { site: ['0', '1'], services: ['0', '1'], doctors: ['0', '1'], create_doctors: ['0', '1'], replace_photos: ['0', '1'] }, { package: { buffer: fs.readFileSync(zipPath), name: 'content.zip' } });
  assert.equal(r.status, 302);
  const result = await a.get('/app/website/import');
  assert.match(result.text, /Dr\. Ruba AlQudah/);
  // draft
  const { doc } = await site.draft(ctx, business);
  assert.equal(doc.pages.length, 3);
  assert.equal(doc.pages[1].slug, 'about');
  assert.equal(doc.header.items.length, 3);
  assert.equal(doc.header.show_name, false);
  assert.equal(doc.footer.show_powered, false);
  const hero = doc.pages[0].sections[0];
  assert.ok(hero.settings.slides[0].image, 'the picture reference became a library id');
  assert.equal(doc.brand.logoMediaId, hero.settings.slides[0].image);
  assert.equal(doc.pages[0].sections[1].settings.items[0].page, SVC);
  // live untouched, previous draft kept as a version
  assert.equal((await knex('clinic_sites').where({ business_id: ctx.businessId }).first()).live_version_id, liveBefore);
  assert.equal(await knex('clinic_site_versions').where({ business_id: ctx.businessId, kind: 'archived' }).count({ n: '*' }).then((x) => Number(x[0].n)), archivedBefore + 1);
  // doctors
  const m = await knex('doctors').where({ id: mansourId }).first();
  assert.equal(m.full_name, 'د. منصور القضاة', 'a Latin-only name gets the Arabic one');
  assert.equal(m.full_name_en, 'Dr. Mansour AlQudah');
  assert.equal(m.bio, 'نبذة الطبيب');
  assert.equal(m.phone, '+962 7 0000 0001');
  assert.ok(m.photo_media_id);
  assert.deepEqual(JSON.parse(m.social_links), { instagram: 'https://instagram.com/mq' }, 'only real profile addresses');
  assert.equal(JSON.parse(m.profile).years, 25);
  const ruba = await knex('doctors').where({ business_id: ctx.businessId, full_name: 'د. ربى القضاة' }).first();
  assert.ok(ruba && ruba.is_active);
  assert.ok(!(await knex('doctors').where({ business_id: ctx.businessId, full_name: 'د. غير موجود' }).first()), 'create: false is respected');
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'website.import' }).first('id'));
  // main and sub-services in the system (an existing service keeps its price and gets the category)
  const cat = await knex('service_categories').where({ business_id: ctx.businessId, name: 'زراعة الأسنان' }).first();
  assert.ok(cat);
  const one = await knex('services').where({ business_id: ctx.businessId, name: 'زراعة سن واحد' }).first();
  assert.equal(one.category_id, cat.id); assert.equal(one.duration_minutes, 60); assert.ok(!one.show_price);
  const checkup = await knex('services').where({ business_id: ctx.businessId, name: 'كشف عام' });
  assert.equal(checkup.length, 1, 'the existing service is not duplicated');
  assert.equal(Number(checkup[0].price), 15);
  // importing again reuses the same pictures (no duplicates)
  const before = await knex('clinic_media').where({ business_id: ctx.businessId }).count({ n: '*' }).then((x) => Number(x[0].n));
  await importer.run(ctx, business, zipPath, {});
  assert.equal(await knex('clinic_media').where({ business_id: ctx.businessId }).count({ n: '*' }).then((x) => Number(x[0].n)), before);
  assert.equal(await knex('services').where({ business_id: ctx.businessId }).count({ n: '*' }).then((x) => Number(x[0].n)), 2, 'services not duplicated on a second import');
  assert.equal(await knex('service_categories').where({ business_id: ctx.businessId }).count({ n: '*' }).then((x) => Number(x[0].n)), 1);
});

test('published: card links to the page, the doctor page shows the full profile, no doctor phone on the site', async () => {
  await site.publish(ctx, business); site.forget(ctx.businessId); cache.forgetPrefix('');
  const v = app.agent();
  let r = await v.get(`/${slug}`);
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`href="/${slug}/p/implants"`));
  assert.doesNotMatch(r.text, /0000 0001/);
  assert.match(r.text, new RegExp(`<h3>تواصل ${tag}</h3>`), 'own footer heading');
  assert.match(r.text, /فرع العبدلي — الطابق 21/);
  r = await v.get(`/${slug}/book`);
  assert.match(r.text, /<optgroup label="زراعة الأسنان"/);
  r = await v.get(`/${slug}/p/implants`);
  assert.match(r.text, new RegExp(`صفحة الزراعة ${tag}`));
  r = await v.get(`/${slug}/doctors/${mansourId}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /class="dp-spec">استشاري جراحة الفم والفكين/);
  assert.match(r.text, /<span class="dp-fact-num num">25\+<\/span>/);
  assert.match(r.text, /<li>خلع أضراس العقل<\/li>/);
  assert.match(r.text, /<li>ماجستير<\/li>/);
  assert.match(r.text, /عضو نقابة أطباء الأسنان/);
  assert.match(r.text, /href="https:\/\/instagram.com\/mq"/);
  assert.doesNotMatch(r.text, /0000 0001/);
  r = await v.get(`/${slug}/doctors/${mansourId}?lang=en`);
  assert.match(r.text, /<li>Wisdom teeth<\/li>/);
});

test('a file that is not a content package is refused; nothing changes', async () => {
  const before = JSON.stringify((await site.draft(ctx, business)).doc);
  const bad = await makeZip({ format: 'something-else', version: 1 });
  await assert.rejects(importer.run(ctx, business, bad, {}), (e) => e.code === 'IMPORT_BAD_FILE');
  fs.unlinkSync(bad);
  assert.throws(() => importer.toTemp(Buffer.from('not a zip at all')), (e) => e.code === 'IMPORT_BAD_FILE');
  assert.equal(JSON.stringify((await site.draft(ctx, business)).doc), before);
});

test('doctor form saves the full profile', async () => {
  const svc = require('../src/modules/clinic/doctors.service'); // eslint-disable-line global-require
  await svc.saveDoctor(ctx, mansourId, { full_name: 'د. منصور القضاة', slot_duration_minutes: '30', consultation_fee: '20', is_active: '1', profile_form: '1', profile_years: '30', profile_languages_ar: 'العربية', profile_focus_ar: 'أ\nب', profile_career_en: 'X\nY' });
  const p = JSON.parse((await knex('doctors').where({ id: mansourId }).first('profile')).profile);
  assert.equal(p.years, 30);
  assert.equal(p.focus.ar, 'أ\nب');
  assert.equal(p.career.en, 'X\nY');
  const a = app.agent(); await a.login(email);
  const f = await a.get(`/app/doctors/${mansourId}/edit`);
  assert.match(f.text, /name="profile_years"[^>]*value="30"/);
});
