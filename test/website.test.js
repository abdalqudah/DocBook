// Clinic website (DocBook 2.0 redesign, phase 4) against the test database: draft → preview → publish, sanitising,
// tenant isolation, take down / put back / restore, the classic page kept for clinics that never published, the
// Website workspace permissions, plan entitlements (locked builder/domain), and the domain alias + HTTPS check.
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
const entitlements = require('../src/modules/subscriptions/entitlements');
const domains = require('../src/modules/branding/domain.service');
const perms = require('../src/modules/rbac/permissions');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (r) => `${r}${tag}@website.test`;
let app; let A; let B;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');

async function clinic(key, slug) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: `Owner ${key}`, email: mail(`owner-${key}`), password: 'Passw0rd!x' });
    await businesses.create(id, { name: `Clinic ${key}`, currency: 'JOD', timezone: 'Asia/Amman', specialty: 'dentistry' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug, booking_enabled: true, phone: '0790000000', about: 'A calm clinic.' });
  const ctx = { businessId, userId, roleKey: 'owner', permissions: await rbac.getUserPermissions(businessId, userId), locale: 'en', timezone: 'Asia/Amman', currency: 'JOD', ip: '127.0.0.1' };
  const doctorId = await setup.addDoctor(ctx, { full_name: `Dr ${key}`, consultation_fee: '20', slot_duration_minutes: '30' });
  const [mediaId] = await knex('clinic_media').insert({ business_id: businessId, name: 'cover.png', mime: 'image/png', size: PNG.length, sha: `sha${key}`.slice(0, 16), data: PNG, width: 1, height: 1, is_public: false });
  const business = await knex('businesses').where({ id: businessId }).first();
  return { ctx, business, doctorId, mediaId, slug };
}
async function addMember(c, roleKey) {
  const role = await rbac.getRoleByKey(c.ctx.businessId, roleKey);
  const id = await knex.transaction((trx) => auth.createUser(trx, { name: roleKey, email: mail(`${roleKey}-${c.slug}`), password: 'Passw0rd!x' }));
  await knex('users').where({ id }).update({ last_business_id: c.ctx.businessId, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: c.ctx.businessId, user_id: id, role_id: role.id });
  rbac.invalidate(c.ctx.businessId);
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  A = await clinic('a', `ws-a-${tag}`.slice(0, 40));
  B = await clinic('b', `ws-b-${tag}`.slice(0, 40));
  await addMember(A, 'receptionist');
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('permissions: website group, transitive implications, owner/manager get it, reception does not', () => {
  assert.equal(perms.ALL.length, 48);
  assert.deepEqual(perms.normalise(['website.publish']), ['website.view', 'website.edit', 'website.publish']);
  const role = (k) => new Set(perms.normalise(perms.SYSTEM_ROLES.find((r) => r.key === k).permissions));
  assert.ok(role('clinic_manager').has('website.domain'));
  assert.ok(!role('receptionist').has('website.view'));
  assert.ok(!role('doctor').has('website.edit'));
});

test('entitlements: typed values, fallbacks, no plan = everything, form parsing', () => {
  assert.equal(entitlements.valueIn(null, 'website.custom_domain'), true);
  assert.equal(entitlements.valueIn(null, 'website.max_pages'), null);
  assert.equal(entitlements.valueIn({}, 'website.builder'), false, 'a plan that does not say → fallback');
  assert.deepEqual(entitlements.valueIn({ 'website.templates': ['dental', 'nope'] }, 'website.templates'), ['dental']);
  const f = entitlements.fromForm({ 'f_website.builder': '1', 'n_media.storage_mb': '500', 'l_website.templates': ['dental', 'general'] });
  assert.equal(f['website.builder'], true);
  assert.equal(f['media.storage_mb'], 500);
  assert.deepEqual(f['website.templates'], ['dental', 'general']);
  assert.equal(f['website.clinic_email'], false);
  assert.ok(entitlements.allows('*', 'x') && !entitlements.allows(['a'], 'b'));
});

test('sanitise: plain text only, unknown types and foreign media/doctors dropped, limits kept', () => {
  const refs = { media: new Set([A.mediaId]), doctors: new Set([A.doctorId]) };
  const doc = sections.sanitize({
    theme: 'nope', brand: { primary: 'red', logoMediaId: B.mediaId },
    pages: [{ key: 'home', sections: [
      { type: 'hero', content: { en: { headline: '<script>alert(1)</script>Hi\u0007', subtext: 'x'.repeat(900) } }, settings: { image: B.mediaId, show_call: '0' } },
      { type: 'doctors', settings: { mode: 'selected', doctor_ids: [A.doctorId, 999999] } },
      { type: 'evil', content: {} },
    ] }],
  }, refs);
  const [hero, docs] = doc.pages[0].sections;
  assert.equal(doc.pages[0].sections.length, 2);
  assert.equal(doc.theme, 'calm');
  assert.equal(doc.brand.primary, null);
  assert.equal(doc.brand.logoMediaId, null, 'another clinic\'s image is never referenced');
  assert.equal(hero.settings.image, null);
  assert.equal(hero.settings.show_call, false);
  assert.equal(hero.content.en.headline, '<script>alert(1)</script>Hi', 'kept as text (escaped when shown), control chars removed');
  assert.equal(hero.content.en.subtext.length, 400);
  assert.deepEqual(docs.settings.doctor_ids, [A.doctorId]);
});

test('draft → preview → publish; the classic page stays until the first publish; escaped output', async () => {
  const pub = app.agent();
  let r = await pub.get(`/${A.slug}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /portal-hero/, 'classic page before the builder is used');
  const o = app.agent();
  await o.login(mail('owner-a'));
  r = await o.get('/app/website/builder');
  assert.equal(r.status, 200);
  const st = await site.state(A.ctx.businessId);
  assert.equal(st.status, 'draft');
  const { doc } = await site.draft(A.ctx, A.business);
  const hero = doc.pages[0].sections.find((s) => s.type === 'hero');
  assert.ok(doc.pages[0].sections.some((s) => s.type === 'services'), 'dental template for a dentistry clinic');
  r = await o.submit('/app/website/builder', `/app/website/builder/sections/${hero.id}`, { 'content[en][headline]': '<b>Smiles</b> for all', 'content[ar][headline]': 'ابتسامة للجميع', 'settings[image]': String(A.mediaId), 'settings[show_call]': '1' });
  assert.equal(r.status, 302);
  // Still the classic page: editing never changes what patients see.
  r = await pub.get(`/${A.slug}`);
  assert.match(r.text, /portal-hero/);
  assert.ok(!/Smiles for all/.test(r.text));
  // Member preview shows the draft, framed only by this site, never indexed.
  r = await o.get('/app/website/preview?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /&lt;b&gt;Smiles&lt;\/b&gt; for all/, 'escaped');
  assert.match(r.text, /noindex/);
  assert.ok(/ws-preview-bar/.test(r.text));
  assert.equal((await pub.get('/app/website/preview')).status, 302, 'members only');
  // Publish.
  r = await o.submit('/app/website/builder', '/app/website/publish', {});
  assert.equal(r.status, 302);
  r = await pub.get(`/${A.slug}?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /&lt;b&gt;Smiles&lt;\/b&gt; for all/);
  assert.match(r.text, /ws-theme-clinical/);
  assert.ok(!/ws-preview-bar/.test(r.text));
  const m = await knex('clinic_media').where({ id: A.mediaId }).first('is_public');
  assert.equal(Boolean(m.is_public), true, 'published images become public');
  assert.ok(await knex('media_usages').where({ business_id: A.ctx.businessId, media_id: A.mediaId, context: 'website' }).first());
  assert.ok(await knex('audit_logs').where({ business_id: A.ctx.businessId, action: 'website.published' }).first());
  // Other clinic unaffected.
  r = await pub.get(`/${B.slug}`);
  assert.match(r.text, /portal-hero/);
});

test('edits after publishing stay in the draft; discard, take down, put back, restore', async () => {
  const o = app.agent();
  await o.login(mail('owner-a'));
  const { doc } = await site.draft(A.ctx, A.business);
  const hero = doc.pages[0].sections.find((s) => s.type === 'hero');
  await o.submit('/app/website/builder', `/app/website/builder/sections/${hero.id}`, { 'content[en][headline]': 'Changed headline' });
  const pub = app.agent();
  let r = await pub.get(`/${A.slug}?lang=en`);
  assert.ok(!/Changed headline/.test(r.text), 'live keeps the published version');
  assert.equal((await site.state(A.ctx.businessId)).draftChanged, true);
  await o.submit('/app/website/builder', '/app/website/builder/discard', {});
  const again = await site.draft(A.ctx, A.business);
  assert.ok(/Smiles/.test(again.doc.pages[0].sections.find((s) => s.type === 'hero').content.en.headline), 'discard → back to the published version');
  // Take down: a short page with booking stays.
  r = await o.submit('/app/website/settings', '/app/website/unpublish', {});
  assert.equal(r.status, 302);
  r = await pub.get(`/${A.slug}`);
  assert.match(r.text, /ws-offline/);
  assert.match(r.text, new RegExp(`/${A.slug}/book`));
  assert.equal((await pub.get(`/${A.slug}/book`)).status, 200, 'booking keeps working');
  await o.submit('/app/website/settings', '/app/website/republish', {});
  r = await pub.get(`/${A.slug}?lang=en`);
  assert.match(r.text, /Smiles/);
  // Versions + restore (into the draft only).
  await o.submit('/app/website/builder', `/app/website/builder/sections/${hero.id}`, { 'content[en][headline]': 'Second version' });
  await o.submit('/app/website/builder', '/app/website/publish', {});
  const versions = await site.versions(A.ctx.businessId);
  assert.ok(versions.length >= 2);
  const old = versions.find((v) => v.kind === 'archived');
  await o.submit('/app/website/settings', `/app/website/versions/${old.id}/restore`, {});
  r = await pub.get(`/${A.slug}?lang=en`);
  assert.match(r.text, /Second version/, 'restore never goes live by itself');
  assert.match(JSON.stringify((await site.draft(A.ctx, A.business)).doc), /Smiles/);
});

test('sections: add (once for single types), move, hide, order, remove; the theme and brand', async () => {
  const o = app.agent();
  await o.login(mail('owner-a'));
  let r = await o.submit('/app/website/builder', '/app/website/builder/sections', { type: 'booking_cta' });
  assert.equal(r.status, 302);
  let { doc } = await site.draft(A.ctx, A.business);
  const cta = doc.pages[0].sections.find((s) => s.type === 'booking_cta');
  assert.ok(cta);
  r = await o.submit('/app/website/builder', '/app/website/builder/sections', { type: 'hero' });
  assert.equal((await site.draft(A.ctx, A.business)).doc.pages[0].sections.filter((s) => s.type === 'hero').length, 1, 'a single-use section is not added twice');
  await o.submit('/app/website/builder', `/app/website/builder/sections/${cta.id}/toggle`, {});
  ({ doc } = await site.draft(A.ctx, A.business));
  assert.equal(doc.pages[0].sections.find((s) => s.id === cta.id).visible, false);
  const ids = doc.pages[0].sections.map((s) => s.id).reverse();
  r = await o.submit('/app/website/builder', '/app/website/builder/order', { ids });
  ({ doc } = await site.draft(A.ctx, A.business));
  assert.deepEqual(doc.pages[0].sections.map((s) => s.id), ids);
  await o.submit('/app/website/builder', `/app/website/builder/sections/${cta.id}/delete`, {});
  assert.ok(!(await site.draft(A.ctx, A.business)).doc.pages[0].sections.some((s) => s.id === cta.id));
  await o.submit('/app/website/theme', '/app/website/theme', { theme: 'warm' });
  await o.submit('/app/website/theme', '/app/website/brand', { use_primary: '1', primary: '#123abc', font: 'serif', radius: 'square' });
  ({ doc } = await site.draft(A.ctx, A.business));
  assert.equal(doc.theme, 'warm');
  assert.equal(doc.brand.primary, '#123abc');
  r = await o.get('/app/website/preview/theme.css');
  assert.match(r.text, /#123abc/i);
  assert.match(r.text, /--site-font: Georgia/);
});

test('tenant isolation: a clinic edits only its own draft; foreign media never referenced', async () => {
  const b = app.agent();
  await b.login(mail('owner-b'));
  const { doc } = await site.draft(A.ctx, A.business);
  const aSection = doc.pages[0].sections[0];
  const r = await b.submit('/app/website/builder', `/app/website/builder/sections/${aSection.id}`, { 'content[en][title]': 'hijack' });
  assert.equal(r.status, 302, 'refused with a message (section not found in this clinic\'s draft)');
  const again = await site.draft(A.ctx, A.business);
  assert.ok(!JSON.stringify(again.doc).includes('hijack'));
  const bDoc = (await site.draft(B.ctx, B.business)).doc;
  const hero = bDoc.pages[0].sections.find((s) => s.type === 'hero');
  await b.submit('/app/website/builder', `/app/website/builder/sections/${hero.id}`, { 'settings[image]': String(A.mediaId) });
  assert.equal((await site.draft(B.ctx, B.business)).doc.pages[0].sections.find((s) => s.type === 'hero').settings.image, null);
});

test('website workspace: reception has no access; moved pages redirect; doctor page works', async () => {
  const rc = app.agent();
  await rc.login(mail(`receptionist-${A.slug}`));
  assert.equal((await rc.get('/app/website')).status, 403);
  assert.equal((await rc.get('/app/website/builder')).status, 403);
  const o = app.agent();
  await o.login(mail('owner-a'));
  let r = await o.get('/app/settings/portal');
  assert.equal(r.status, 301);
  assert.equal(r.location, '/app/website/settings');
  assert.equal((await o.get('/app/settings/media')).location, '/app/website/media');
  assert.equal((await o.get('/app/settings/booking-links')).location, '/app/website/booking/links');
  assert.equal((await o.get('/app/reviews')).location, '/app/website/reviews');
  for (const p of ['/app/website', '/app/website/theme', '/app/website/booking', '/app/website/booking/links', '/app/website/media', '/app/website/domain', '/app/website/settings', '/app/website/reviews']) {
    r = await o.get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /data-nav-ws="website"[^>]*>|class="active"[^>]*data-nav-ws="website"/, `${p}: website workspace`);
  }
  r = await app.agent().get(`/${A.slug}/doctors/${A.doctorId}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Dr a/);
  assert.equal((await app.agent().get(`/${A.slug}/doctors/${B.doctorId}`)).status, 404, 'another clinic\'s doctor is not found');
});

test('plan entitlements: a package without the builder/domain shows a locked page; the public page keeps working', async () => {
  const subs = require('../src/modules/subscriptions/subscriptions.service'); // eslint-disable-line global-require
  const [planId] = await knex('subscription_plans').insert({ name: `No website ${tag}`, price_monthly: 1, price_yearly: 10, currency: 'JOD', features: JSON.stringify(entitlements.fromForm({})), is_active: true, is_public: false });
  const before = await knex('platform_settings').where({ key: 'subscriptions' }).first();
  try {
    await knex('platform_settings').insert({ key: 'subscriptions', value: JSON.stringify({ ...(before ? JSON.parse(before.value) : {}), enabled: true }) }).onConflict('key').merge();
    await knex('clinic_subscriptions').insert({ business_id: B.ctx.businessId, plan_id: planId, status: 'active', billing_cycle: 'monthly', current_period_start: '2026-01-01', current_period_end: '2099-01-01' }).onConflict('business_id').merge();
    cache.forgetPrefix('');
    const b = app.agent();
    await b.login(mail('owner-b'));
    let r = await b.get('/app/website/builder');
    assert.equal(r.status, 200);
    assert.match(r.text, /ws-locked/);
    r = await b.submit('/app/website', '/app/website/publish', {});
    assert.match((await b.get('/app/website/builder')).text, /ws-locked/);
    r = await b.get('/app/website/domain');
    assert.match(r.text, /ws-locked/);
    assert.equal((await app.agent().get(`/${B.slug}`)).status, 200, 'the clinic page never depends on the package');
    assert.ok(typeof subs.settings === 'function');
  } finally {
    if (before) await knex('platform_settings').where({ key: 'subscriptions' }).update({ value: before.value });
    else await knex('platform_settings').where({ key: 'subscriptions' }).del();
    await knex('clinic_subscriptions').where({ business_id: B.ctx.businessId }).del();
    cache.forgetPrefix('');
  }
});

test('domain: alias (www ↔ bare) needs the main domain, redirects when both are verified; HTTPS status is observed', async () => {
  assert.equal(domains.counterpart('www.clinic-a.test'), 'clinic-a.test');
  await assert.rejects(domains.saveAlias(A.ctx), { code: 'DOMAIN_NONE' });
  const host = `www.ws${tag}.com`;
  await domains.save(A.ctx, host);
  const main = await domains.forClinic(A.ctx.businessId);
  await knex('clinic_domains').where({ id: main.id }).update({ status: 'verified' });
  const alias = await domains.saveAlias(A.ctx);
  assert.equal(alias.host, `ws${tag}.com`);
  assert.equal(alias.role, 'alias');
  await knex('clinic_domains').where({ id: alias.id }).update({ status: 'verified' });
  domains.forget();
  const live = await domains.clinicForHost(alias.host);
  assert.equal(live.redirectTo, host);
  const r = await app.agent().get('/', { host: alias.host });
  assert.equal(r.status, 301);
  assert.equal(r.location, `http://${host}/`);
  // HTTPS: observed with an injected probe (no network in tests).
  let s = await domains.checkSsl(A.ctx, A.ctx.businessId, { probe: async () => ({ reachable: true, authorized: true, validTo: new Date(Date.now() + 90 * 86_400_000) }) });
  assert.equal(s.ssl_status, 'active');
  s = await domains.checkSsl(A.ctx, A.ctx.businessId, { probe: async () => ({ reachable: true, authorized: false, error: 'ERR_TLS_CERT_ALTNAME_INVALID' }) });
  assert.equal(s.ssl_status, 'pending', 'the host\'s default certificate = still being issued');
  s = await domains.checkSsl(A.ctx, A.ctx.businessId, { probe: async () => ({ reachable: true, authorized: false, error: 'CERT_HAS_EXPIRED' }) });
  assert.equal(s.ssl_status, 'failed');
  assert.ok(domains.isPrivate('192.168.1.5') && !domains.isPrivate('8.8.8.8'));
  await domains.remove(A.ctx);
  assert.equal(await domains.aliasFor(A.ctx.businessId), null, 'removing the main domain removes the alias');
});
