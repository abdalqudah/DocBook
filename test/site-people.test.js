// Website people and slider: a doctor's social profiles (validated, shown on the doctor cards), the "cards" layout of
// the doctors section, words over the slider pictures on/off, and "My photo" in My account (also the doctor's photo).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const setup = require('../src/modules/onboarding/setup.service');
const site = require('../src/modules/website/site.service');
const sections = require('../src/modules/website/sections');
const doctors = require('../src/modules/clinic/doctors.service');
const social = require('../src/modules/clinic/doctor-social');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const email = `ppl-${tag}@t.test`;
const slug = `ppl-${tag}`.slice(0, 40);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
let app; let ctx; let business; let doctorId; let mediaId;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Dr Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'People clinic', currency: 'JOD', timezone: 'Asia/Amman', specialty: 'dentistry' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug, booking_enabled: true });
  ctx = { businessId, userId, roleKey: 'owner', permissions: await rbac.getUserPermissions(businessId, userId), locale: 'en', timezone: 'Asia/Amman', currency: 'JOD', ip: '127.0.0.1' };
  doctorId = await setup.addDoctor(ctx, { full_name: `Dr Card ${tag}`, consultation_fee: '20', slot_duration_minutes: '30' });
  [mediaId] = await knex('clinic_media').insert({ business_id: businessId, name: 'slide.png', mime: 'image/png', size: PNG.length, sha: `sl${tag}`.slice(0, 16), data: PNG, width: 1, height: 1, is_public: true });
  business = await knex('businesses').where({ id: businessId }).first();
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('social links: only real profile addresses, https added, stored on the doctor', async () => {
  assert.equal(social.cleanOne('instagram', 'instagram.com/dr.card'), 'https://instagram.com/dr.card');
  assert.equal(social.cleanOne('facebook', 'https://evil.example/facebook.com'), null);
  assert.equal(social.cleanOne('x', 'javascript:alert(1)'), null);
  assert.equal(social.cleanOne('website', 'http://plain.example'), null, 'https only');
  const base = { full_name: `Dr Card ${tag}`, slot_duration_minutes: '30', consultation_fee: '20', is_active: '1', social_form: '1' };
  await assert.rejects(doctors.saveDoctor(ctx, doctorId, { ...base, social_facebook: 'https://evil.example/x' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.social_facebook));
  await doctors.saveDoctor(ctx, doctorId, { ...base, social_instagram: 'instagram.com/dr.card', social_linkedin: 'https://www.linkedin.com/in/drcard', social_facebook: '' });
  const d = await knex('doctors').where({ id: doctorId }).first('social_links');
  assert.deepEqual(social.read(d.social_links), { instagram: 'https://instagram.com/dr.card', linkedin: 'https://www.linkedin.com/in/drcard' });
  // the doctor form shows them back
  const a = app.agent(); await a.login(email);
  const form = await a.get(`/app/doctors/${doctorId}/edit`);
  assert.match(form.text, /name="social_instagram"[^>]*value="https:\/\/instagram.com\/dr.card"|value="https:\/\/instagram.com\/dr.card"[^>]*name="social_instagram"/);
});

test('website: doctor cards with social icons; slider words hidden', async () => {
  await site.edit(ctx, business, (doc) => {
    const page = doc.pages[0];
    const hero = page.sections.find((s) => s.type === 'hero');
    hero.variant = 'slider'; hero.settings.slide_text = 'txt_none'; hero.settings.slide_buttons = false;
    hero.settings.slides = [{ image: mediaId, text_mode: 'txt_follow' }, { image: mediaId, text_mode: 'txt_all' }];
    hero.content.en.slides = [{ headline: `First ${tag}`, subtext: 'Lead one' }, { headline: `Second ${tag}`, subtext: 'Lead two' }];
    const docs = page.sections.find((s) => s.type === 'doctors');
    docs.variant = 'cards';
    return doc;
  }, { note: null });
  await site.publish(ctx, business);
  site.forget(ctx.businessId); cache.forgetPrefix('');
  const r = await app.agent().get(`/${slug}?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /class="ws-dcard"/);
  assert.match(r.text, /href="https:\/\/instagram.com\/dr.card"[^>]*rel="noopener nofollow"/);
  assert.match(r.text, /"sameAs":\["https:\/\/instagram.com\/dr.card"/);
  // slide 1 follows the slider (no words: a hidden headline for search engines, the picture at full strength)
  assert.match(r.text, new RegExp(`<h1 class="sr-only">First ${tag}</h1>`));
  assert.match(r.text, /ws-slide is-on is-bare/);
  assert.doesNotMatch(r.text, /Lead one/);
  // slide 2 keeps its own words
  assert.match(r.text, new RegExp(`Second ${tag}`));
  assert.match(r.text, /Lead two/);
  // the sanitiser keeps only known choices
  const { doc } = await site.draft(ctx, business);
  assert.equal(doc.pages[0].sections.find((s) => s.type === 'hero').settings.slide_text, 'txt_none');
});

test('My account: my photo becomes the doctor\'s photo; removing it clears both', async () => {
  const a = app.agent(); await a.login(email);
  await knex('memberships').where({ business_id: ctx.businessId, user_id: ctx.userId }).update({ doctor_id: doctorId });
  rbac.invalidate(ctx.businessId);
  let r = await a.upload('/app/settings/account', '/app/settings/account/photo', {}, { photo: { buffer: PNG, name: 'me.png' } });
  assert.equal(r.status, 302);
  const mem = await knex('memberships').where({ business_id: ctx.businessId, user_id: ctx.userId }).first('photo_media_id');
  assert.ok(mem.photo_media_id);
  const d = await knex('doctors').where({ id: doctorId }).first('photo_media_id');
  assert.equal(d.photo_media_id, mem.photo_media_id);
  const m = await knex('clinic_media').where({ id: mem.photo_media_id }).first('is_public', 'folder', 'business_id');
  assert.ok(m.is_public && m.folder === 'team' && m.business_id === ctx.businessId);
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'user.photo_updated' }).first('id'));
  r = await a.get('/app/settings/account');
  assert.match(r.text, new RegExp(`<span class="avatar avatar-lg acc-photo"><img src="/app/media/${mem.photo_media_id}`));
  assert.match(r.text, new RegExp(`class="user-chip"><span class="avatar"><img src="/app/media/${mem.photo_media_id}`), 'the top bar shows it too');
  cache.forgetPrefix('');
  r = await app.agent().get(`/${slug}?lang=en`);
  assert.match(r.text, new RegExp(`/m/${slug}/${mem.photo_media_id}`), 'the website shows the new photo');
  // not an image → refused, nothing changes
  r = await a.upload('/app/settings/account', '/app/settings/account/photo', {}, { photo: { buffer: Buffer.from('%PDF-1.4 x'), name: 'x.pdf' } });
  assert.equal(r.status, 302);
  assert.equal((await knex('memberships').where({ business_id: ctx.businessId, user_id: ctx.userId }).first('photo_media_id')).photo_media_id, mem.photo_media_id);
  // remove
  const page = await a.get('/app/settings/account');
  r = await a.post('/app/settings/account/photo/delete', { _csrf: a.csrf(page.text) });
  assert.equal(r.status, 302);
  assert.equal((await knex('memberships').where({ business_id: ctx.businessId, user_id: ctx.userId }).first('photo_media_id')).photo_media_id, null);
  assert.equal((await knex('doctors').where({ id: doctorId }).first('photo_media_id')).photo_media_id, null);
});
