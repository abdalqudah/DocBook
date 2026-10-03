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
  assert.equal(perms.ALL.length, 49); // + billing.void (admins void invoices)
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

test('clinic e-mail: validation, write-only encrypted password, test, routing by kind, fallback, isolation', async () => {
  const m = require('../src/modules/clinicmail/clinicmail.service'); // eslint-disable-line global-require
  const mailer = require('../src/core/mailer'); // eslint-disable-line global-require
  const sent = [];
  let failNext = false;
  m._setBuild(() => ({ verify: async () => true, sendMail: async (msg) => { if (failNext) { failNext = false; throw Object.assign(new Error('boom'), { code: 'EAUTH' }); } sent.push(msg); return { messageId: `<${sent.length}@t>` }; }, close() {} }));
  try {
    await assert.rejects(m.saveSmtp(A.ctx, { smtp_host: 'localhost', smtp_port: '587', smtp_user: 'u', smtp_password: 'p', from_address: 'a@clinic-a.test' }), (e) => Boolean(e.details && e.details.smtp_host));
    await assert.rejects(m.saveSmtp(A.ctx, { smtp_host: '10.0.0.5', smtp_port: '587', smtp_user: 'u', smtp_password: 'p', from_address: 'a@clinic-a.test' }), (e) => Boolean(e.details && e.details.smtp_host));
    await assert.rejects(m.saveSmtp(A.ctx, { smtp_host: 'smtp.clinic-a.test', smtp_port: '8080', smtp_user: 'u', smtp_password: 'p', from_address: 'a@clinic-a.test' }), (e) => Boolean(e.details && e.details.smtp_port));
    await assert.rejects(m.saveSmtp(A.ctx, { smtp_host: 'smtp.clinic-a.test', smtp_port: '587', smtp_user: 'u', from_address: 'a@clinic-a.test' }), (e) => Boolean(e.details && e.details.smtp_password), 'a password is required the first time');
    await m.saveSmtp(A.ctx, { smtp_host: 'smtp.clinic-a.test', smtp_port: '465', smtp_user: 'appointments', smtp_password: 'S3cret-Pass!', from_address: 'appointments@clinic-a.test', from_name: 'Clinic A' });
    const row = await knex('clinic_mail_accounts').where({ business_id: A.ctx.businessId }).first();
    assert.ok(row.secret_enc && !row.secret_enc.includes('S3cret'), 'stored encrypted');
    assert.equal(row.smtp_security, 'ssl');
    assert.equal(row.status, 'pending');
    // Same server & user without a password keeps the saved one (write-only form).
    await m.saveSmtp(A.ctx, { smtp_host: 'smtp.clinic-a.test', smtp_port: '465', smtp_user: 'appointments', smtp_password: '', from_address: 'appointments@clinic-a.test' });
    assert.equal((await knex('clinic_mail_accounts').where({ business_id: A.ctx.businessId }).first()).secret_enc, row.secret_enc);
    // The page never shows the secret.
    const o = app.agent();
    await o.login(mail('owner-a'));
    let r = await o.get('/app/website/email');
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('S3cret'));
    assert.ok(!r.text.includes(row.secret_enc));
    // Not verified yet → the platform sends (not configured in tests → false) and nothing leaves from the clinic.
    assert.equal(await mailer.send({ to: 'p@x.test', subject: 's', html: 'h', businessId: A.ctx.businessId, kind: 'reminders' }), false);
    assert.equal(sent.length, 0);
    assert.equal((await m.testConnection(A.ctx)).ok, true);
    assert.equal((await m.status(A.ctx.businessId)).status, 'verified');
    // Verified → clinic e-mails go out from the clinic address; account e-mails never do.
    assert.equal(await mailer.send({ to: 'p@x.test', subject: 'Reminder', html: 'h', businessId: A.ctx.businessId, kind: 'reminders' }), true);
    assert.equal(sent[0].from.address, 'appointments@clinic-a.test');
    await mailer.send({ to: 'u@x.test', subject: 'Reset your password', html: 'h' });
    assert.equal(sent.length, 1, 'no businessId → platform only');
    // Kinds the clinic turned off use the platform.
    await m.saveSender(A.ctx, { uses: ['patient_letters'], from_name: 'Clinic A', from_address: 'appointments@clinic-a.test' });
    await mailer.send({ to: 'p@x.test', subject: 'Reminder 2', html: 'h', businessId: A.ctx.businessId, kind: 'reminders' });
    assert.equal(sent.length, 1);
    // A failure falls back to the platform and is logged.
    failNext = true;
    await mailer.send({ to: 'p@x.test', subject: 'Letter', html: 'h', businessId: A.ctx.businessId, kind: 'patient_letters' });
    assert.ok(await knex('clinic_mail_log').where({ business_id: A.ctx.businessId, status: 'fallback' }).first());
    // Isolation: clinic B has no account and cannot see A's.
    assert.equal(await m.status(B.ctx.businessId), null);
    const b = app.agent();
    await b.login(mail('owner-b'));
    r = await b.get('/app/website/email');
    assert.ok(!r.text.includes('appointments@clinic-a.test'));
    // Test sends are limited per hour.
    for (let i = 0; i < 5; i += 1) await m.testSend(A.ctx, 'owner@x.test', { subject: 't', html: 'h' }); // eslint-disable-line no-await-in-loop
    await assert.rejects(m.testSend(A.ctx, 'owner@x.test', { subject: 't', html: 'h' }), { code: 'RATE_LIMITED' });
    await m.disconnect(A.ctx);
    assert.equal(await m.status(A.ctx.businessId), null);
    assert.ok(await knex('audit_logs').where({ business_id: A.ctx.businessId, action: 'email.disconnected' }).first());
  } finally {
    m._setBuild(null);
  }
  // Private networks are refused when the host resolves to them.
  await assert.rejects(m.resolvePublic('smtp.evil.test', { resolve4: async () => ['127.0.0.1', '10.1.2.3'] }), { code: 'MAIL_HOST_PRIVATE' });
  assert.equal(await m.resolvePublic('smtp.ok.test', { resolve4: async () => ['10.0.0.1', '93.184.216.34'] }), '93.184.216.34');
});

test('clinic e-mail OAuth: state is bound to this browser and clinic; the account comes from the token response', async () => {
  const oauth = require('../src/modules/clinicmail/oauth'); // eslint-disable-line global-require
  process.env.MS_CLIENT_ID = 'ms-client'; process.env.MS_CLIENT_SECRET = 'ms-secret';
  try {
    const { url, pending } = await oauth.start('microsoft', A.ctx.businessId);
    const u = new URL(url);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('scope'), /SMTP\.Send/);
    await assert.rejects(oauth.finish(pending, { state: 'wrong', code: 'c' }, A.ctx.businessId), { code: 'MAIL_OAUTH_STATE' });
    await assert.rejects(oauth.finish(pending, { state: pending.state, code: 'c' }, B.ctx.businessId), { code: 'MAIL_OAUTH_STATE' }, 'another clinic cannot finish it');
    const payload = Buffer.from(JSON.stringify({ email: 'Front@Clinic-A.test' })).toString('base64url');
    oauth._setFetch(async (href, init) => {
      assert.match(String(init.body), /code_verifier=/);
      return { ok: true, json: async () => ({ refresh_token: 'rt-1', id_token: `x.${payload}.y` }) };
    });
    const r = await oauth.finish(pending, { state: pending.state, code: 'c' }, A.ctx.businessId);
    assert.deepEqual(r, { provider: 'microsoft', account: 'front@clinic-a.test', refreshToken: 'rt-1' });
    const opts = await oauth.transportOptions('microsoft', { user: r.account, refreshToken: r.refreshToken });
    assert.equal(opts.auth.type, 'OAuth2');
    assert.equal(opts.host, 'smtp.office365.com');
  } finally {
    delete process.env.MS_CLIENT_ID; delete process.env.MS_CLIENT_SECRET;
    oauth._setFetch((...a) => fetch(...a));
  }
});

test('SEO tab: title/description go live on publish; share image and hide from search (advanced)', async () => {
  const o = app.agent();
  await o.login(mail('owner-a'));
  let r = await o.get('/app/website/seo');
  assert.equal(r.status, 200);
  await o.submit('/app/website/seo', '/app/website/seo', { title_en: 'Best dental care in town', description_en: 'Gentle dentists.', image_media_id: String(A.mediaId), hide: '1' });
  r = await app.agent().get(`/${A.slug}?lang=en`);
  assert.ok(!/Best dental care in town/.test(r.text), 'not before publishing');
  await o.submit('/app/website/builder', '/app/website/publish', {});
  r = await app.agent().get(`/${A.slug}?lang=en`);
  assert.match(r.text, /<title>Best dental care in town/);
  assert.match(r.text, /name="robots" content="noindex/);
  assert.match(r.text, new RegExp(`og:image" content="[^"]*/m/${A.slug}/${A.mediaId}`));
  await o.submit('/app/website/seo', '/app/website/seo', { title_en: 'Best dental care in town', description_en: 'Gentle dentists.', image_media_id: String(A.mediaId) });
  await o.submit('/app/website/builder', '/app/website/publish', {});
});

test('statistics: anonymous visits counted per day and kind; staff and robots are not; the page shows them', async () => {
  const today = require('../src/modules/clinic/scheduling').clinicNow('Asia/Amman').date; // eslint-disable-line global-require
  const count = async (kind) => Number(((await knex('clinic_site_stats').where({ business_id: A.ctx.businessId, day: today, kind }).first()) || {}).views || 0);
  const before = await count('home');
  const visitor = app.agent();
  await visitor.get(`/${A.slug}`);
  await visitor.get(`/${A.slug}`, { 'user-agent': 'Googlebot/2.1' });
  await visitor.get(`/${A.slug}/book`);
  await visitor.get(`/${A.slug}/doctors/${A.doctorId}`);
  const o = app.agent();
  await o.login(mail('owner-a'));
  await o.get(`/${A.slug}`);
  await new Promise((res) => setTimeout(res, 150)); // counters are written without waiting
  assert.equal(await count('home'), before + 1, 'one anonymous visit; robot and staff not counted');
  assert.ok(await count('book') >= 1);
  assert.ok(await count('doctor') >= 1);
  const r = await o.get('/app/website/analytics');
  assert.equal(r.status, 200);
  assert.match(r.text, /ws-days/);
  const cookie = (await visitor.get(`/${A.slug}`)).text;
  assert.ok(cookie.length > 0);
});

test('daily domain re-check: never takes a domain down, notifies the people who manage it', async () => {
  const host = `recheck${tag}.com`;
  await domains.save(B.ctx, host);
  const d = await domains.forClinic(B.ctx.businessId);
  await knex('clinic_domains').where({ id: d.id }).update({ status: 'verified', checked_at: new Date(Date.now() - 3 * 86_400_000) });
  const resolver = { resolveTxt: async () => [[`docbook-verify=${d.token}`]], resolveCname: async () => [], resolve4: async (h) => (h === host ? ['203.0.113.9'] : ['198.51.100.1']) }; // the domain now points elsewhere
  const r = await domains.recheckDue({ resolver, probe: async () => ({ reachable: true, authorized: true, validTo: new Date(Date.now() + 90 * 86_400_000) }) });
  assert.ok(r.checked >= 1);
  const after = await domains.forClinic(B.ctx.businessId);
  assert.equal(after.status, 'verified', 'still live');
  const n = await knex('notifications').where({ business_id: B.ctx.businessId, type: 'domain.problem' }).first();
  assert.ok(n, 'the pointing problem is reported');
  await domains.remove(B.ctx);
});

test('Today: the optional "put your clinic online" card after the setup checklist, until the site is live', async () => {
  await knex('businesses').where({ id: B.ctx.businessId }).update({ setup_dismissed_at: new Date() });
  const b = app.agent();
  await b.login(mail('owner-b'));
  let r = await b.get('/app');
  assert.match(r.text, /today-online/);
  const o = app.agent();
  await o.login(mail('owner-a'));
  await knex('businesses').where({ id: A.ctx.businessId }).update({ setup_dismissed_at: new Date() });
  r = await o.get('/app');
  assert.ok(!/today-online/.test(r.text), 'A is live');
});

test('free blocks and section looks: cards, text with image, numbers, steps, text, divider; plain text and clinic actions only', () => {
  const doc = sections.defaultDoc('general');
  const cards = sections.blankSection('cards');
  cards.content.en.items = { 0: { title: '<b>One</b>', text: 'x' }, 1: { title: 'Two' } };
  cards.settings.items = { 0: { icon: 'heart', image: String(A.mediaId), action: 'book' }, 1: { icon: 'javascript:alert(1)', image: '999999', action: 'https://evil.test' } };
  cards.settings.style = { align: 'center', bg: 'image', bg_image: String(B.mediaId), shape_bottom: 'wave', shape_top: '<svg>', spacing: 'roomy', width: 'wide', evil: 'x' };
  doc.pages[0].sections.push(cards, sections.blankSection('image_text'), sections.blankSection('stats'), sections.blankSection('steps'), sections.blankSection('text'), sections.blankSection('divider'));
  const out = sections.sanitize(doc, { media: new Set([A.mediaId]), doctors: new Set() });
  const c = out.pages[0].sections.find((s) => s.type === 'cards');
  assert.equal(c.content.en.items[0].title, '<b>One</b>', 'stored as plain text (escaped on output)');
  assert.deepEqual(c.settings.items[0], { icon: 'heart', image: A.mediaId, action: 'book' });
  assert.deepEqual(c.settings.items[1], { icon: sections.ICONS[0], image: null, action: 'none' }, 'unknown icon, foreign picture and free address dropped');
  assert.deepEqual(c.settings.style, { align: 'center', bg: 'image', bg_image: null, overlay: 'dark', spacing: 'roomy', width: 'wide', shape_top: 'none', shape_bottom: 'wave', anim: 'auto' });
  assert.ok(sections.mediaIn(out).includes(A.mediaId), 'pictures inside cards are published with the site');
  for (const type of ['image_text', 'stats', 'steps', 'text', 'divider']) assert.ok(out.pages[0].sections.find((s) => s.type === type).settings.style, `${type} has a look`);
});

test('builder: full screen, saves as you type (JSON), the preview shows the new blocks with their look', async () => {
  const o = app.agent();
  await o.login(mail('owner-a'));
  let r = await o.submit('/app/website/builder', '/app/website/builder/sections', { type: 'cards' });
  const id = new URL(r.location, 'http://x').searchParams.get('s');
  assert.match(id, /^[a-f0-9]{10}$/);
  r = await o.get(`/app/website/builder?s=${id}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /class="wsb-body"/, 'own layout');
  assert.ok(!/class="sidebar/.test(r.text), 'no app menu around the editor');
  assert.match(r.text, /data-ws-tab-body="design"/);
  const csrf = (r.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  r = await o.post(`/app/website/builder/sections/${id}`, {
    _csrf: csrf, variant: 'overlay', 'content[en][title]': 'Why us', 'content[en][items][0][title]': '<script>x</script>Care', 'content[en][items][0][button]': 'Book now',
    'settings[items][0][icon]': 'heart', 'settings[items][0][action]': 'book', 'settings[columns]': '2', 'settings[style][bg]': 'brand', 'settings[style][align]': 'center', 'settings[style][shape_bottom]': 'wave',
  }, { accept: 'application/json' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { ok: true });
  r = await o.get('/app/website/preview');
  assert.match(r.text, new RegExp(`data-ws-sec="${id}"`));
  assert.match(r.text, /ws-block ws-t-cards ws-a-center ws-bg-brand/);
  assert.match(r.text, /ws-cards-overlay ws-cols-2/);
  assert.match(r.text, /class="ws-shape ws-shape-bottom"/);
  assert.match(r.text, /&lt;script&gt;x&lt;\/script&gt;Care/);
  assert.ok(!/<script>x<\/script>/.test(r.text));
  assert.match(r.text, new RegExp(`href="/${A.slug}/book"[^>]*>[\\s\\S]*?Book now`));
  r = await o.post(`/app/website/builder/sections/${id}`, { _csrf: csrf, variant: 'grid' }, { accept: 'application/json' });
  assert.equal(r.status, 200, 'a partial save keeps the section valid');
});

test('hero slider and motion: slides with their own words, motion classes, empty sections shown only in the preview', async () => {
  const doc = sections.defaultDoc('general');
  assert.equal(doc.brand.motion, 'subtle', 'new sites start with subtle motion');
  assert.equal(sections.sanitize({ ...doc, brand: { ...doc.brand, motion: undefined } }).brand.motion, 'none', 'older sites stay still');
  const o = app.agent();
  await o.login(mail('owner-a'));
  const { doc: d } = await site.draft(A.ctx, A.business);
  const hero = d.pages[0].sections.find((s) => s.type === 'hero');
  const html = await o.get(`/app/website/builder?s=${hero.id}`);
  const csrf = (html.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  assert.match(html.text, /data-ws-only="slider" hidden/, 'slider options wait for the slider layout');
  let r = await o.post(`/app/website/builder/sections/${hero.id}`, {
    _csrf: csrf, variant: 'slider', 'settings[slides][0][image]': String(A.mediaId), 'content[en][slides][0][headline]': 'First slide', 'settings[interval]': 's7', 'settings[transition]': 'zoom', 'settings[height]': 'tall', 'settings[style][anim]': 'zoom',
  }, { accept: 'application/json' });
  assert.equal(r.status, 200);
  r = await o.submit('/app/website/theme', '/app/website/brand', { motion: 'lively', font: 'system', radius: 'rounded' });
  r = await o.submit('/app/website/builder', '/app/website/builder/sections', { type: 'steps' });
  const faqId = new URL(r.location, 'http://x').searchParams.get('s');
  r = await o.get('/app/website/preview?lang=en');
  assert.match(r.text, /data-ws-slider data-interval="7"/);
  assert.match(r.text, /ws-tr-zoom ws-h-tall/);
  assert.match(r.text, /<h1>First slide<\/h1>/);
  assert.match(r.text, /ws-motion-lively/);
  assert.match(r.text, /ws-anim ws-anim-zoom/);
  assert.match(r.text, new RegExp(`ws-placeholder-block" data-ws-sec="${faqId}"`), 'an empty new section can be found and clicked in the preview');
  await o.submit('/app/website/builder', '/app/website/publish', {});
  r = await app.agent().get(`/${A.slug}`);
  assert.ok(!r.text.includes('ws-placeholder'), 'never on the live site');
  assert.match(r.text, /website-site\.js/);
});

test('pages, menu and footer: add a page, its address, menu links, footer; live at /<slug>/p/<page>; plan and safety limits', async () => {
  const o = app.agent();
  await o.login(mail('owner-a'));
  let r = await o.submit('/app/website/builder', '/app/website/builder/pages', { 'title[ar]': 'من نحن', 'title[en]': 'About us' });
  assert.equal(r.status, 302);
  const key = new URL(r.location, 'http://x').searchParams.get('page');
  assert.match(key, /^[a-f0-9]{10}$/);
  let { doc } = await site.draft(A.ctx, A.business);
  const pg = doc.pages.find((p) => p.key === key);
  assert.equal(pg.slug, 'about-us');
  assert.equal(pg.sections[0].type, 'text', 'a new page starts with a text section');
  const html = (await o.get(`/app/website/builder?page=${key}&panel=page`)).text;
  const csrf = (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  r = await o.post(`/app/website/builder/pages/${key}`, { _csrf: csrf, slug: 'book' }, { accept: 'application/json' });
  assert.equal(r.status, 422, 'a reserved address is refused');
  r = await o.post(`/app/website/builder/pages/${key}`, { _csrf: csrf, slug: 'our-story', 'title[en]': 'Our story', 'title[ar]': 'قصتنا', menu: '1' }, { accept: 'application/json' });
  assert.equal(r.status, 200);
  await o.post(`/app/website/builder/sections/${pg.sections[0].id}`, { _csrf: csrf, variant: 'plain', 'content[en][title]': 'Since 2010' }, { accept: 'application/json' });
  r = await o.post('/app/website/builder/header', {
    _csrf: csrf, 'header[style]': 'centered', 'header[sticky]': '0', 'header[items][0][pick]': `page:${key}`, 'header[items][1][pick]': 'book', 'header[items][1][label][en]': 'Book now', 'header[items][2][pick]': 'page:ffffffffff',
  }, { accept: 'application/json' });
  assert.equal(r.status, 200);
  r = await o.post('/app/website/builder/footer', {
    _csrf: csrf, 'footer[style]': 'centered', 'footer[about][en]': 'Family dental care.', 'footer[social][instagram]': 'https://instagram.com/clinic.a', 'footer[social][facebook]': 'javascript:alert(1)', 'footer[show_powered]': '0',
  }, { accept: 'application/json' });
  assert.equal(r.status, 200);
  ({ doc } = await site.draft(A.ctx, A.business));
  assert.deepEqual(doc.header.items.map((i) => i.kind), ['page', 'book'], 'a link to an unknown page is dropped');
  assert.equal(doc.footer.social.facebook, '', 'only https links on the network itself');
  await o.submit('/app/website/builder', '/app/website/publish', {});
  const v = app.agent();
  r = await v.get(`/${A.slug}/p/our-story?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Since 2010/);
  assert.match(r.text, /<title>Our story · /);
  assert.match(r.text, /ws-nav ws-nav-centered is-static/);
  assert.match(r.text, new RegExp(`href="/${A.slug}/p/our-story" aria-current="page">Our story`));
  assert.match(r.text, /Book now/);
  assert.match(r.text, /Family dental care\./);
  assert.match(r.text, /href="https:\/\/instagram\.com\/clinic\.a"/);
  assert.match(r.text, /portal\.powered|DocBook|href="\/"/, 'the platform line stays unless the package allows hiding it');
  assert.equal((await v.get(`/${A.slug}/p/nope`)).status, 404);
  // removing the page takes its menu link away
  await o.submit('/app/website/builder?panel=pages', `/app/website/builder/pages/${key}/delete`, {});
  ({ doc } = await site.draft(A.ctx, A.business));
  assert.deepEqual(doc.header.items.map((i) => i.kind), ['book']);
  // package without extra pages
  const before = await knex('platform_settings').where({ key: 'subscriptions' }).first();
  const [planId] = await knex('subscription_plans').insert({ name: `No pages ${tag}`, price_monthly: 1, price_yearly: 10, currency: 'JOD', features: JSON.stringify({ ...entitlements.fromForm({}), 'website.builder': true, 'website.max_pages': 0 }), is_active: true, is_public: false });
  try {
    await knex('platform_settings').insert({ key: 'subscriptions', value: JSON.stringify({ ...(before ? JSON.parse(before.value) : {}), enabled: true }) }).onConflict('key').merge();
    await knex('clinic_subscriptions').insert({ business_id: A.ctx.businessId, plan_id: planId, status: 'active', billing_cycle: 'monthly', current_period_start: '2026-01-01', current_period_end: '2099-01-01' }).onConflict('business_id').merge();
    cache.forgetPrefix('');
    r = await o.submit('/app/website/builder', '/app/website/builder/pages', { 'title[en]': 'Extra' });
    ({ doc } = await site.draft(A.ctx, A.business));
    assert.equal(doc.pages.length, 1, 'the package allows no extra page');
  } finally {
    if (before) await knex('platform_settings').where({ key: 'subscriptions' }).update({ value: before.value });
    else await knex('platform_settings').where({ key: 'subscriptions' }).del();
    await knex('clinic_subscriptions').where({ business_id: A.ctx.businessId }).del();
    cache.forgetPrefix('');
  }
});

test('SEO, GEO and AIO: structured data, map position, FAQ, llms.txt per clinic, AI crawler opt-out, own-domain crawl files', async () => {
  const o = app.agent();
  await o.login(mail('owner-b'));
  let r = await o.submit('/app/website/seo', '/app/website/seo', {
    title_en: 'Clinic B', description_en: 'Care in Amman', keywords_en: 'dentist Amman', geo_lat: '31.95', geo_lng: '35.91', area_en: 'Amman, Zarqa', area_ar: '', price: '$$',
    ai_summary_en: 'A family clinic <b>in</b> Amman.', ai_bots: 'allow',
  });
  assert.equal(r.status, 302);
  const { doc } = await site.draft(B.ctx, B.business);
  assert.deepEqual(doc.seo.geo, { lat: 31.95, lng: 35.91 });
  await site.edit(B.ctx, B.business, (d) => {
    const faq = sections.blankSection('faq'); faq.content.en.items = [{ q: 'Do you see children?', a: 'Yes.' }];
    d.pages[0].sections.push(faq); return d;
  }, { note: null });
  await site.publish(B.ctx, B.business);
  site.forget(B.ctx.businessId);
  const v = app.agent();
  r = await v.get(`/${B.slug}?lang=en`);
  assert.match(r.text, /<meta name="geo.position" content="31.95;35.91">/);
  assert.match(r.text, /<meta name="keywords" content="dentist Amman">/);
  assert.match(r.text, /"@type":\["MedicalClinic","Dentist"\]/);
  assert.match(r.text, /"areaServed":\[\{"@type":"Place","name":"Amman"\}/);
  assert.match(r.text, /"@type":"FAQPage"/);
  assert.match(r.text, /llms\.txt/);
  r = await v.get(`/${B.slug}/llms.txt`);
  assert.equal(r.status, 200);
  assert.match(r.text, /^# Clinic b/m);
  assert.match(r.text, /> A family clinic in Amman\./, 'plain text only');
  assert.match(r.text, /Map position: 31.95, 35.91/);
  assert.match(r.text, /### Do you see children\?/);
  // opting out of AI assistants
  await o.submit('/app/website/seo', '/app/website/seo', { title_en: 'Clinic B', ai_bots: 'block' });
  await site.publish(B.ctx, B.business);
  site.forget(B.ctx.businessId); cache.forgetPrefix('site:');
  assert.equal((await v.get(`/${B.slug}/llms.txt`)).status, 404);
  assert.match((await v.get(`/${B.slug}`)).text, /content="noai, noimageai"/);
  r = await v.get('/robots.txt');
  assert.match(r.text, new RegExp(`User-agent: GPTBot[\\s\\S]*?Disallow: /${B.slug}\\n`));
  // own domain: the clinic's robots.txt and sitemap.xml
  const host = `seo${tag}.com`;
  await domains.save(B.ctx, host);
  await knex('clinic_domains').where({ business_id: B.ctx.businessId, host }).update({ status: 'verified' });
  domains.forget();
  r = await app.agent().get('/robots.txt', { host });
  assert.match(r.text, /User-agent: ClaudeBot\nDisallow: \//);
  assert.match(r.text, new RegExp(`Sitemap: http://${host}/sitemap.xml`));
  r = await app.agent().get('/sitemap.xml', { host });
  assert.match(r.text, new RegExp(`<loc>http://${host}/book</loc>`));
});

test('typography: fonts checked by content, served from the clinic, chosen for text/headings; colours only for the light look', async () => {
  const fontsSvc = require('../src/modules/website/fonts.service'); // eslint-disable-line global-require
  const render = require('../src/modules/website/render'); // eslint-disable-line global-require
  const ttf = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(60, 1)]);
  assert.equal(fontsSvc.formatOf(ttf), 'ttf');
  assert.equal(fontsSvc.formatOf(Buffer.from('wOF2xxxxxxxxxxxx')), 'woff2');
  assert.equal(fontsSvc.formatOf(Buffer.from('<svg onload=alert(1)></svg>')), null);
  await assert.rejects(fontsSvc.upload(A.ctx, { buffer: Buffer.from('<html>not a font</html>'), originalname: 'x.ttf' }), { code: 'FONT_TYPE' });
  const f = await fontsSvc.upload(A.ctx, { buffer: ttf, originalname: 'Brand-Bold.ttf' }, { family: 'Brand</style><script>', weight: '700' });
  assert.equal(f.family, 'Brandstylescript', 'the family name is plain text');
  const o = app.agent();
  await o.login(mail('owner-a'));
  let r = await o.submit('/app/website/theme', '/app/website/brand', { body_font: 'serif', heading_font: `f${f.id}`, size: 'l', heading_weight: '800', use_heading: '1', heading: '#7a1f3d', use_text: '1', text: '#dddddd', use_link: '0', font: 'system', radius: 'rounded' });
  assert.equal(r.status, 302);
  r = await o.get('/app/website/theme');
  assert.match(r.text, /warn-text/, 'a pale text colour gets a contrast warning');
  r = await o.get('/app/website/preview/theme.css');
  assert.match(r.text, new RegExp(`@font-face \\{ font-family: "ws-font-${f.id}"; src: url\\("/app/website/fonts/${f.id}\\?v=`));
  assert.match(r.text, /--site-font-head: "ws-font-\d+"/);
  assert.match(r.text, /--site-fs: 17.5px/);
  assert.match(r.text, /:root\[data-theme="light"\] \{ --site-text: #dddddd; --site-heading: #7a1f3d; \}/);
  assert.ok(!/:root \{[^}]*--site-text/.test(r.text), 'never forced on the dark look');
  await o.submit('/app/website/builder', '/app/website/publish', {});
  site.forget(A.ctx.businessId);
  r = await app.agent().get(`/${A.slug}/fonts/${f.id}.ttf`);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'font/ttf');
  assert.equal((await app.agent().get(`/${B.slug}/fonts/${f.id}.ttf`)).status, 404, "another clinic's address does not serve it");
  // removing the font sends the draft back to the built-in stack
  await o.submit('/app/website/theme', `/app/website/fonts/${f.id}/delete`, {});
  const { doc } = await site.draft(A.ctx, A.business);
  assert.equal(doc.brand.headingFont, 'serif');
  assert.ok(render.contrastOnWhite('#000000') > 20);
});

test('images and columns sections (2/3/4 per row); dark logo; dark mode off keeps the site and booking light', async () => {
  const doc = sections.sanitize((await site.draft(A.ctx, A.business)).doc);
  const mk = (type, variant, en, settings) => ({ id: `${type.slice(0, 4)}${tag}`.slice(0, 12), type, variant, visible: true, content: { ar: en, en }, settings });
  doc.pages[0].sections.push(
    mk('images', 'framed', { title: 'Our rooms', items: [{ caption: 'Reception' }] }, { columns: '4', items: [{ image: A.mediaId }] }),
    mk('columns', 'boxed', { title: 'Why us', items: [{ title: 'Experience', text: '15 years' }, { title: 'Care', text: 'Gentle' }] }, { columns: '2', items: [{ icon: 'award' }, { image: A.mediaId }] }),
  );
  doc.brand.logoMediaId = A.mediaId; doc.brand.logoDarkMediaId = A.mediaId;
  doc.header.dark_mode = false;
  const clean = sections.sanitize(doc, { media: new Set([A.mediaId]) });
  assert.ok(clean.pages[0].sections.some((s) => s.type === 'images' && s.settings.columns === '4'));
  assert.ok(clean.pages[0].sections.some((s) => s.type === 'columns' && s.settings.columns === '2'));
  assert.equal(clean.brand.logoDarkMediaId, A.mediaId);
  assert.equal(clean.header.dark_mode, false);
  await site.saveDraft(A.ctx, A.business, clean);
  await site.publish(A.ctx, A.business);
  site.forget(A.ctx.businessId);
  let r = await app.agent().get(`/${A.slug}?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<html[^>]*data-theme="light"/);
  assert.ok(!/data-theme-toggle/.test(r.text), 'no dark switch when dark mode is off');
  assert.match(r.text, /ws-images ws-images-framed ws-cols-4/);
  assert.match(r.text, /<figcaption>Reception<\/figcaption>/);
  assert.match(r.text, /ws-columns ws-columns-boxed ws-cols-2/);
  r = await app.agent().get(`/${A.slug}/book?lang=en`);
  assert.match(r.text, /<html[^>]*data-theme="light"/, 'booking pages follow the site');
  // dark mode back on: the switch returns; the dark logo is offered for dark mode
  const o = app.agent(); await o.login(mail('owner-a'));
  r = await o.submit('/app/website/theme', '/app/website/dark', { dark_mode: '1' });
  assert.equal(r.status, 302);
  r = await app.agent().get(`/${A.slug}?lang=en`); // no publishing needed: the switch reaches the live site
  assert.ok(!/<html[^>]*data-theme="light"/.test(r.text));
  assert.match(r.text, /data-theme-toggle/);
  assert.match(r.text, /class="logo-dark"/);
  // off again from the builder's header panel: live at once too
  r = await o.submit('/app/website/builder?panel=header', '/app/website/builder/header', { 'header[dark_mode]': '0' });
  r = await app.agent().get(`/${A.slug}?lang=en`);
  assert.match(r.text, /<html[^>]*data-theme="light"/);
});

test('main services and sub-services: what the website and booking page show is the clinic\'s choice', async () => {
  const o = app.agent(); await o.login(mail('owner-a'));
  let r = await o.submit('/app/services', '/app/services/categories', { name: 'تقويم الأسنان', is_active: '1', site_field: '1', show_on_site: '1' });
  assert.equal(r.status, 302);
  const cat = await knex('service_categories').where({ business_id: A.ctx.businessId, name: 'تقويم الأسنان' }).first();
  r = await o.submit('/app/services', '/app/services', { name: 'Shown Sub', price: '', duration_minutes: '30', category_id: cat.id, is_active: '1', site_field: '1', show_on_site: '1' });
  assert.equal(r.status, 302, 'no price needed');
  await o.submit('/app/services', '/app/services', { name: 'Hidden Sub', price: '15', duration_minutes: '30', category_id: cat.id, is_active: '1', show_price: '1', site_field: '1' });
  const hidden = await knex('services').where({ business_id: A.ctx.businessId, name: 'Hidden Sub' }).first();
  assert.equal(Boolean(hidden.show_on_site), false);
  const pub = app.agent();
  r = await pub.get(`/${A.slug}/book?lang=en`);
  assert.match(r.text, /Shown Sub/);
  assert.doesNotMatch(r.text, /Hidden Sub/, 'a sub-service hidden from the site');
  r = await o.get('/app/services?lang=en');
  assert.match(r.text, /Hidden from the website/);
  // hiding the main service hides its sub-services
  await o.submit('/app/services', `/app/services/categories/${cat.id}`, { name: 'تقويم الأسنان', is_active: '1', site_field: '1' });
  r = await pub.get(`/${A.slug}/book?lang=en`);
  assert.doesNotMatch(r.text, /Shown Sub/);
  // still available inside the clinic (the doctor's bill)
  assert.ok(await knex('services').where({ business_id: A.ctx.businessId, name: 'Shown Sub', is_active: true }).first());
});

test('a mail server name that does not exist: the nearby name that does is used', async () => {
  const mailSvc = require('../src/modules/clinicmail/clinicmail.service');
  const resolver = { resolve4: async (h) => { if (h === 'doc.thinkn.test') return ['93.184.216.34']; const e = new Error('nf'); e.code = 'ENOTFOUND'; throw e; } };
  assert.deepEqual(await mailSvc.workingHost('mail.doc.thinkn.test', 'info@doc.thinkn.test', resolver), { host: 'doc.thinkn.test', changedFrom: 'mail.doc.thinkn.test' });
  assert.deepEqual(await mailSvc.workingHost('doc.thinkn.test', 'info@doc.thinkn.test', resolver), { host: 'doc.thinkn.test', changedFrom: null });
  assert.deepEqual(await mailSvc.workingHost('nowhere.invalid', 'x@nowhere.invalid', resolver), { host: 'nowhere.invalid', changedFrom: null });
});

test('partners carousel, carousel options on list sections, alignment, and the dental icon library', async () => {
  const o = app.agent();
  await o.login(mail('owner-a'));
  let r = await o.submit('/app/website/builder', '/app/website/builder/sections', { type: 'partners' });
  assert.equal(r.status, 302);
  let { doc } = await site.draft(A.ctx, A.business);
  const p = doc.pages[0].sections.find((s) => s.type === 'partners');
  assert.ok(p && p.settings.carousel === true && p.settings.per_view === '5', 'partners slide by default');
  r = await o.submit('/app/website/builder', `/app/website/builder/sections/${p.id}`, {
    variant: 'logos', 'content[ar][title]': 'شركاؤنا', 'content[en][title]': 'Our partners',
    'settings[items][0][image]': String(A.mediaId), 'settings[items][0][name]': 'Lab One',
    'settings[items][1][image]': String(A.mediaId), 'settings[items][1][name]': 'Insurer Two',
    'settings[carousel]': '1', 'settings[per_view]': '4', 'settings[car_dir]': 'right', 'settings[autoplay]': 's3', 'settings[style][align]': 'center',
  });
  assert.equal(r.status, 302);
  ({ doc } = await site.draft(A.ctx, A.business));
  const saved = doc.pages[0].sections.find((s) => s.id === p.id);
  assert.equal(saved.settings.items.length, 2);
  assert.equal(saved.settings.car_dir, 'right');
  r = await o.get('/app/website/preview?lang=en');
  assert.match(r.text, /class="[^"]*ws-carousel[^"]*ws-a-center|class="[^"]*ws-a-center[^"]*ws-carousel/);
  assert.match(r.text, /data-ws-carousel data-per="4" data-dir="right" data-auto="s3"/);
  assert.match(r.text, /<ul class="ws-partners ws-partners-logos/);
  assert.match(r.text, /alt="Lab One"/);

  // Cards can slide too; an unknown direction falls back to "follow the language".
  r = await o.submit('/app/website/builder', '/app/website/builder/sections', { type: 'cards' });
  ({ doc } = await site.draft(A.ctx, A.business));
  const cards = doc.pages[0].sections.filter((s) => s.type === 'cards').pop();
  assert.equal(cards.settings.carousel, false, 'a grid until the clinic turns the carousel on');
  r = await o.submit('/app/website/builder', `/app/website/builder/sections/${cards.id}`, {
    variant: 'grid', 'content[en][items][0][title]': 'Implants', 'content[ar][items][0][title]': 'زراعة', 'settings[items][0][icon]': 'dt-implant',
    'content[en][items][1][title]': 'Braces', 'settings[items][1][icon]': 'dt-braces', 'settings[carousel]': '1', 'settings[car_dir]': 'sideways',
  });
  ({ doc } = await site.draft(A.ctx, A.business));
  const c2 = doc.pages[0].sections.find((s) => s.id === cards.id);
  assert.equal(c2.settings.car_dir, 'auto');
  assert.deepEqual(c2.settings.items.map((x) => x.icon), ['dt-implant', 'dt-braces'], 'dental icons are valid');

  // The dental clinic's icon picker opens on the dental library.
  r = await o.get(`/app/website/builder?s=${cards.id}&lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<option value="dentistry" selected>Dentistry ★<\/option>/);
  assert.match(r.text, /data-ws-iconlib="dentistry">/);
  assert.match(r.text, /#i-dt-tooth"/);
});

test('icon libraries: every specialty has a large library, every icon is in the sprite and accepted by sections', () => {
  const lib = require('../src/modules/website/icon-library');
  const sprite = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'icons.svg'), 'utf8');
  for (const k of lib.KEYS) {
    assert.ok(lib.LIBS[k].length >= 20, `${k} has at least 20 icons`);
    for (const ic of lib.LIBS[k]) assert.ok(sprite.includes(`id="i-${ic}"`), `${ic} is in icons.svg`);
  }
  assert.equal(lib.libFor('orthopaedics'), 'orthopaedics');
  assert.equal(lib.libFor('multi'), 'general');
  const sections = require('../src/modules/website/sections');
  const s = sections.blankSection('features');
  s.settings.items = [{ icon: 'or-knee' }, { icon: 'oph-chart' }, { icon: 'javascript:alert(1)' }];
  const doc = sections.sanitize({ pages: [{ key: 'home', sections: [s] }] });
  assert.deepEqual(doc.pages[0].sections[0].settings.items.map((x) => x.icon), ['or-knee', 'oph-chart', sections.ICONS[0]]);
});
