// Clinic media storage: the platform default while no package applies, the package's media.storage_mb, the size the
// platform admin sets for one clinic (Admin → clinic → File storage), uploads refused past it, and the pricing cards.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const media = require('../src/modules/integrations/media.service');
const ops = require('../src/modules/platformops/ops.service');
const pricing = require('../src/modules/site/pricing');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PNG_2x2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYGD4z8DAwMDAwMDAAAANBAEB8yJyWQAAAABJRU5ErkJggg==', 'base64');
const MB = 1024 * 1024;
let app; let admin; let ctx; const realPlanFeatures = ops.planFeatures;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: `mq${tag}@t.test`, password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'عيادة المساحة', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  ctx = { businessId, userId };
  const adminId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Admin', email: `mq-admin-${tag}@t.test`, password: 'Passw0rd!x' }));
  await knex('users').where({ id: adminId }).update({ is_platform_admin: true, email_verified_at: new Date() });
  app = await serve();
  admin = app.agent();
  await admin.login(`mq-admin-${tag}@t.test`);
});
test.after(async () => { ops.planFeatures = realPlanFeatures; if (app) await app.close(); await knex.destroy(); });

const fill = (bytes) => knex('clinic_media').insert({ business_id: ctx.businessId, name: 'big.png', folder: '', mime: 'image/png', size: bytes, width: 2, height: 2, sha: `f${tag}`.slice(0, 16), data: PNG_2x2, is_public: false, created_at: new Date(), updated_at: new Date() });

test('no package → the platform default; a package → its media.storage_mb (empty = no limit)', async () => {
  ops.planFeatures = async () => null;
  let s = await media.stats(ctx.businessId);
  assert.equal(s.quota, media.DEFAULT_MB * MB);
  assert.equal(s.source, 'default');
  ops.planFeatures = async () => ({ 'media.storage_mb': 500 });
  s = await media.stats(ctx.businessId);
  assert.equal(s.quotaMb, 500);
  assert.equal(s.source, 'plan');
  ops.planFeatures = async () => ({ 'media.storage_mb': null });
  s = await media.stats(ctx.businessId);
  assert.equal(s.quota, null);
  ops.planFeatures = realPlanFeatures;
});

test('the admin sets this clinic\'s own size: shown on the clinic page, enforced on upload, audited; "follow the package" clears it', async () => {
  const page = await admin.get(`/admin/clinics/${ctx.businessId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="storage"/);
  assert.match(page.text, /name="media_quota_mb"/);

  let r = await admin.post(`/admin/clinics/${ctx.businessId}/storage`, { _csrf: admin.csrf(page.text), media_quota_mb: '-4' });
  assert.equal(r.status, 302);
  assert.equal((await knex('businesses').where({ id: ctx.businessId }).first('media_quota_mb')).media_quota_mb, null);

  r = await admin.post(`/admin/clinics/${ctx.businessId}/storage`, { _csrf: admin.csrf(page.text), media_quota_mb: '1' });
  assert.equal(r.status, 302);
  assert.equal((await knex('businesses').where({ id: ctx.businessId }).first('media_quota_mb')).media_quota_mb, 1);
  const s = await media.stats(ctx.businessId);
  assert.equal(s.quota, MB);
  assert.equal(s.source, 'clinic');
  const log = await knex('audit_logs').where({ action: 'platform.clinic_storage', entity_id: ctx.businessId }).first();
  assert.ok(log);

  await fill(MB - 10);
  await assert.rejects(media.upload(ctx, { buffer: PNG_2x2, originalname: 'a.png' }, {}), (e) => e.code === 'MEDIA_QUOTA');

  // More space from the admin → the same upload goes through.
  await admin.post(`/admin/clinics/${ctx.businessId}/storage`, { _csrf: admin.csrf(page.text), media_quota_mb: '50' });
  const up = await media.upload(ctx, { buffer: PNG_2x2, originalname: 'a.png' }, {});
  assert.ok(up.id);

  await admin.post(`/admin/clinics/${ctx.businessId}/storage`, { _csrf: admin.csrf(page.text), media_quota_mb: '50', follow_plan: '1' });
  assert.equal((await knex('businesses').where({ id: ctx.businessId }).first('media_quota_mb')).media_quota_mb, null);
});

test('pricing cards carry the package storage (GB from 1024 MB, empty = unlimited)', async () => {
  const plans = await pricing.forSite();
  for (const p of plans.plans) assert.ok(p.storage === null || (p.storage.n && ['mb', 'gb'].includes(p.storage.unit)));
  const big = plans.plans.find((p) => p.storage && p.storage.unit === 'gb');
  if (big) assert.ok(Number(String(big.storage.n).replace(/,/g, '')) >= 1);
});
