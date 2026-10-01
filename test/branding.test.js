// Invoice letterhead layout (logo / name places, size, name on/off), the clinic's browser icon (platform / logo /
// uploaded, public pages and the app), and the platform admin's logo and icon.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const ops = require('../src/modules/platformops/ops.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `brand-${k}-${tag}@t.test`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
let app; let ctx; let slug; let adminId; let savedAssets;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail('owner'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'عيادة الهوية', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  slug = `brand-${tag}`.slice(0, 40);
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug, booking_enabled: true, name_en: 'MQ' });
  businesses.forget(businessId);
  ctx = { businessId, userId, ip: '127.0.0.1' };
  adminId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Admin', email: mail('admin'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: adminId }).update({ is_platform_admin: true, email_verified_at: new Date() });
  savedAssets = await knex('platform_assets').select('*');
  app = await serve();
});
test.after(async () => {
  await knex('platform_assets').del();
  if (savedAssets.length) await knex('platform_assets').insert(savedAssets);
  await knex('platform_settings').where({ key: 'branding' }).del();
  cache.forgetPrefix('');
  if (app) await app.close();
  await knex.destroy();
});

test('invoice header: logo and name each in their place, logo size, name hidden', async () => {
  const tpl = await ops.invoiceTemplate(ctx.businessId);
  assert.equal(tpl.logo_pos, 'start'); assert.equal(tpl.show_name, true);
  const body = { ...Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, v === true ? '1' : v === false ? '' : v])), logo_pos: 'center', name_pos: 'end', logo_size: 'xl', show_name: '' };
  await ops.saveInvoiceTemplate(ctx, body);
  const saved = await ops.invoiceTemplate(ctx.businessId);
  assert.equal(saved.logo_pos, 'center'); assert.equal(saved.name_pos, 'end'); assert.equal(saved.logo_size, 'xl'); assert.equal(saved.show_name, false);
  const bad = await ops.saveInvoiceTemplate(ctx, { ...body, logo_pos: 'top' }).catch((e) => e);
  assert.equal(bad.code, 'VALIDATION_FAILED');
  // render the letterhead partial with a logo
  const ejs = require('ejs'); // eslint-disable-line global-require
  const html = await ejs.renderFile('src/views/pages/clinic/billing/_letterhead.ejs', {
    lh: { paper: 'a4', title: 'Invoice', number: 'INV-7', date: '2026-10-01' }, business: { id: 1, name: 'عيادة', name_en: 'MQ', logo_mime: 'image/png', logo_version: 1, address: 'x' },
    invoiceTpl: saved, locale: 'ar', t: (k) => k, fmt: { date: (d) => d },
  }, { async: false });
  assert.match(html, /ivd-logo-xl/);
  assert.match(html, /is-center[^"]*">\s*<img class="ivd-lh-logo"/);
  assert.ok(!/ivd-lh-name"/.test(html), 'name hidden');
  assert.match(html, /is-start[^"]*">[\s\S]*ivd-lh-title/, 'the invoice number takes the start side when the name is at the end');
  const o = app.agent(); await o.login(mail('owner'));
  const page = await o.get('/app/settings/invoice?lang=en');
  assert.match(page.text, /name="logo_pos" value="center" checked/);
});

test('clinic browser icon: platform, the clinic logo, or an uploaded icon — on its pages and in the app', async () => {
  const o = app.agent(); await o.login(mail('owner'));
  let r = await o.get(`/${slug}/favicon`);
  assert.equal(r.status, 302, 'the platform icon by default');
  r = await o.upload('/app/settings/appearance', '/app/settings/appearance/favicon', { favicon_mode: 'custom' }, { favicon: { buffer: Buffer.from('<svg onload=alert(1)>'), name: 'x.png' } });
  assert.equal(r.status, 302);
  assert.equal((await knex('businesses').where({ id: ctx.businessId }).first('favicon_mode')).favicon_mode, 'platform', 'a non-image is refused');
  r = await o.upload('/app/settings/appearance', '/app/settings/appearance/favicon', { favicon_mode: 'platform' }, { favicon: { buffer: PNG, name: 'icon.png' } });
  const b = await knex('businesses').where({ id: ctx.businessId }).first('favicon_mode', 'favicon_mime', 'favicon_version');
  assert.equal(b.favicon_mode, 'custom'); assert.equal(b.favicon_mime, 'image/png');
  r = await app.agent().get(`/${slug}/favicon`);
  assert.equal(r.status, 200); assert.match(r.type, /image\/png/);
  r = await app.agent().get(`/${slug}/book?lang=en`);
  assert.match(r.text, new RegExp(`rel="icon" href="/${slug}/favicon\\?v=c${b.favicon_version}"`));
  r = await o.get('/app?lang=en');
  assert.match(r.text, /rel="icon" href="\/app\/favicon\?v=c/);
  // back to the platform icon
  r = await o.upload('/app/settings/appearance', '/app/settings/appearance/favicon', { favicon_mode: 'platform' }, {});
  r = await o.get('/app?lang=en');
  assert.match(r.text, /rel="icon" href="\/favicon\.svg"/);
  const log = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'clinic.favicon_updated' }).count({ n: '*' });
  assert.ok(Number(log[0].n) >= 2);
});

test('platform branding: the admin uploads a logo and icon; pages use them; the name can be hidden', async () => {
  const a = app.agent(); await a.login(mail('admin'));
  let r = await a.get('/admin/branding?lang=en');
  assert.equal(r.status, 200);
  r = await a.upload('/admin/branding', '/admin/branding', { show_name: ['0'] }, { logo: { buffer: PNG, name: 'logo.png' }, favicon: { buffer: PNG, name: 'fav.png' } });
  assert.equal(r.status, 302);
  r = await app.agent().get('/login?lang=en');
  assert.match(r.text, /<img class="brand-logo logo-light" src="\/brand\/logo\?v=\d+"/);
  assert.ok(!/class="brand-word"/.test(r.text), 'the name is hidden next to the logo');
  assert.match(r.text, /rel="icon" href="\/brand\/favicon\?v=\d+"/);
  r = await app.agent().get('/brand/logo');
  assert.equal(r.status, 200); assert.match(r.type, /image\/png/);
  // a clinic member cannot change it
  const o = app.agent(); await o.login(mail('owner'));
  r = await o.get('/admin/branding');
  assert.notEqual(r.status, 200);
  r = await a.upload('/admin/branding', '/admin/branding', { show_name: ['0', '1'], remove: ['logo', 'favicon'] }, {});
  r = await app.agent().get('/login?lang=en');
  assert.ok(!/brand\/logo/.test(r.text), 'back to the built-in mark');
});
