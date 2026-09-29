// Reps & warehouses (vendors): sign-up transaction, approval gates publishing, specialty filtering of the
// clinic-side catalog/offers, the portal guard for suspended vendors, and image sniffing.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const vendors = require('../src/modules/vendors/vendor.service');
const { requireVendor } = require('../src/middleware/vendor');

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(40, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const form = (over = {}) => ({
  type: 'rep', name: 'مندوب تجريبي', contact_name: 'Rep Person', phone: '+962 79 000 1111', country: 'JO', city: 'Amman',
  specialties: ['dentistry'], email: 'rep@v.test', password: 'Passw0rd!x', terms: 'on', ...over,
});
let adminId; let businessId;

test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  cache.clear();
  adminId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Admin', email: 'admin@v.test', password: 'Passw0rd!x' }));
  await knex('users').where({ id: adminId }).update({ is_platform_admin: true });
  const ownerId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: 'owner@v.test', password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Dental Clinic', currency: 'JOD', timezone: 'Asia/Amman', specialty: 'dentistry' }, trx);
    return id;
  });
  ({ last_business_id: businessId } = await knex('users').where({ id: ownerId }).first('last_business_id'));
});
test.after(() => knex.destroy());

test('sign-up creates user + pending vendor + owner link + specialties in one transaction', async () => {
  await assert.rejects(vendors.signup(form({ specialties: [] })), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.specialties));
  await assert.rejects(vendors.signup(form({ specialties: ['multi'] })), (e) => e.code === 'VALIDATION_FAILED');
  assert.equal(Number((await knex('users').where({ email: 'rep@v.test' }).count({ n: '*' }))[0].n), 0, 'nothing written on invalid input');

  const { userId, vendorId } = await vendors.signup(form({ specialties: ['dentistry', 'general'] }), { locale: 'ar' });
  const v = await knex('vendors').where({ id: vendorId }).first();
  assert.equal(v.status, 'pending');
  assert.equal(v.email, 'rep@v.test');
  const link = await knex('vendor_users').where({ vendor_id: vendorId, user_id: userId }).first();
  assert.equal(link.role, 'owner');
  assert.deepEqual((await knex('vendor_specialties').where({ vendor_id: vendorId }).pluck('specialty')).sort(), ['dentistry', 'general']);
  assert.ok(await knex('audit_logs').where({ action: 'vendor.registered', entity_id: String(vendorId) }).whereNull('business_id').first());

  await assert.rejects(vendors.signup(form()), (e) => e.code === 'VENDOR_EMAIL_TAKEN');
  // An existing account (no vendor yet) can register; a second registration is refused.
  const other = await knex.transaction((trx) => auth.createUser(trx, { name: 'Existing', email: 'existing@v.test', password: 'Passw0rd!x' }));
  const user = await knex('users').where({ id: other }).first();
  const vid = await vendors.registerExisting(user, { ...form(), email: undefined, password: undefined });
  assert.equal((await vendors.vendorOfUser(other)).id, vid);
  await assert.rejects(vendors.registerExisting(user, form()), (e) => e.code === 'VENDOR_EXISTS');
});

async function makeVendor(email, specialties, status = 'pending') {
  const { userId, vendorId } = await vendors.signup(form({ email, specialties }));
  if (status !== 'pending') await vendors.setStatus({ userId: adminId }, vendorId, status);
  return { userId, vendorId, ctx: { vendorId, userId } };
}

test('a pending vendor cannot publish; after approval it can', async () => {
  const { vendorId, ctx } = await makeVendor('pending@v.test', ['dentistry']);
  const out = await vendors.saveOffer(ctx, null, { title: 'Offer A', specialties: ['dentistry'] }, null, { publish: true, vendorStatus: 'pending', today: '2026-10-01' });
  assert.equal(out.publishBlocked, true);
  assert.equal((await knex('vendor_offers').where({ id: out.id }).first()).status, 'draft');
  await assert.rejects(vendors.setOfferStatus(ctx, out.id, 'published', { vendorStatus: 'pending' }), (e) => e.code === 'VENDOR_NOT_APPROVED');

  const res = await vendors.setStatus({ userId: adminId }, vendorId, 'active');
  assert.equal(res.firstApproval, true);
  assert.ok(await knex('audit_logs').where({ action: 'platform.vendor_approved', entity_id: String(vendorId) }).whereNull('business_id').first());
  await vendors.setOfferStatus(ctx, out.id, 'published', { vendorStatus: 'active', today: '2026-10-01' });
  assert.equal((await knex('vendor_offers').where({ id: out.id }).first()).status, 'published');
  // Offers of other vendors are not reachable
  const other = await makeVendor('other@v.test', ['dentistry'], 'active');
  await assert.rejects(vendors.setOfferStatus(other.ctx, out.id, 'archived', { vendorStatus: 'active' }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(vendors.saveOffer(other.ctx, null, { title: 'Steal', specialties: ['dentistry'], product_ids: [999999] }), (e) => e.code === 'VALIDATION_FAILED');
});

test('catalog and offers are filtered by specialty, vendor status, activity and dates', async () => {
  const dent = await makeVendor('dent@v.test', ['dentistry'], 'active');
  const derm = await makeVendor('derm@v.test', ['dermatology'], 'active');
  const pend = await makeVendor('pend@v.test', ['dentistry']);
  const p1 = await vendors.saveProduct(dent.ctx, null, { name: 'Composite', specialties: ['dentistry'], is_active: '1', price: '10', currency: 'JOD' });
  const p2 = await vendors.saveProduct(dent.ctx, null, { name: 'Gloves', specialties: ['dentistry', 'dermatology'], is_active: '1' });
  const p3 = await vendors.saveProduct(dent.ctx, null, { name: 'Hidden item', specialties: ['dentistry'] });
  const p4 = await vendors.saveProduct(derm.ctx, null, { name: 'Sunscreen', specialties: ['dermatology'], is_active: '1' });
  const p5 = await vendors.saveProduct(pend.ctx, null, { name: 'Pending item', specialties: ['dentistry'], is_active: '1' });
  await assert.rejects(vendors.saveProduct(dent.ctx, null, { name: 'Priced', price: '5', specialties: ['dentistry'] }), (e) => Boolean(e.details.currency));

  const ids = (r) => r.rows.map((x) => x.id).sort((a, b) => a - b);
  assert.deepEqual(ids(await vendors.productsForSpecialty({ specialty: 'dentistry' })), [p1, p2]);
  assert.deepEqual(ids(await vendors.productsForSpecialty({ specialty: 'dermatology' })), [p2, p4]);
  const all = await vendors.productsForSpecialty({});
  assert.ok(!ids(all).includes(p3) && !ids(all).includes(p5), 'inactive and pending-vendor products are hidden');
  assert.deepEqual(ids(await vendors.productsForSpecialty({ q: 'sun' })), [p4]);
  assert.deepEqual(ids(await vendors.productsForSpecialty({ vendorId: dent.vendorId })), [p1, p2]);
  const one = await vendors.product(p1);
  assert.equal(one.vendor.id, dent.vendorId);
  assert.equal(one.price, 10);
  assert.equal(await vendors.product(p5), null);
  assert.equal(await vendors.vendorPublic(pend.vendorId), null);
  assert.equal((await vendors.vendorPublic(dent.vendorId)).name, 'مندوب تجريبي');
  assert.equal(vendors.scopeForClinic('multi'), null);
  assert.equal(vendors.scopeForClinic('dentistry'), 'dentistry');

  const mk = async (c, title, sp, extra = {}) => (await vendors.saveOffer(c.ctx, null, { title, specialties: sp, ...extra }, null, { publish: true, vendorStatus: 'active', today: '2026-10-01' })).id;
  const o1 = await mk(dent, 'Dental now', ['dentistry'], { product_ids: [p1] });
  const o2 = await mk(dent, 'Dental later', ['dentistry'], { starts_on: '2026-11-01' });
  const o3 = await mk(dent, 'Dental ended', ['dentistry'], { starts_on: '2026-09-01', ends_on: '2026-09-30' }).catch(() => null);
  const o4 = await mk(derm, 'Derm', ['dermatology']);
  assert.equal(o3, null, 'an offer whose end date passed cannot be published');
  const seen = (await vendors.offersForSpecialty('dentistry', { today: '2026-10-01' })).map((o) => o.id);
  assert.ok(seen.includes(o1) && !seen.includes(o2) && !seen.includes(o4));
  assert.deepEqual((await vendors.offersForSpecialty('dentistry', { today: '2026-10-01' })).find((o) => o.id === o1).products.map((p) => p.id), [p1]);

  const before = await vendors.countNewOffers('dentistry', businessId, '2026-10-01');
  await vendors.recordOfferView(o1, businessId);
  await vendors.recordOfferView(o1, businessId);
  assert.equal(await vendors.countNewOffers('dentistry', businessId, '2026-10-01'), before - 1);
  assert.equal((await vendors.ownOffer(dent.ctx, o1)).views, 1);
  await vendors.dismissOffer(o1, businessId);
  assert.ok(!(await vendors.offersForSpecialty('dentistry', { today: '2026-10-01', businessId })).some((o) => o.id === o1));

  // Platform moderation hides content from clinics
  await vendors.hideProduct({ userId: adminId }, p1);
  assert.deepEqual(ids(await vendors.productsForSpecialty({ specialty: 'dentistry' })), [p2]);
  await vendors.setStatus({ userId: adminId }, derm.vendorId, 'suspended');
  assert.deepEqual(ids(await vendors.productsForSpecialty({ specialty: 'dermatology' })), [p2]);
  assert.ok(!(await vendors.offersForSpecialty('dermatology', { today: '2026-10-01' })).some((o) => o.id === o4));
});

test('the portal guard blocks suspended vendors and accounts without a vendor', async () => {
  const run = (user) => new Promise((resolve) => {
    const req = { user, session: {}, method: 'GET', originalUrl: '/vendor', ip: '127.0.0.1', get: () => '' };
    const res = { locals: {}, redirect: (to) => resolve({ redirect: to }) };
    requireVendor(req, res, (err) => resolve({ err, req }));
  });
  const a = await makeVendor('guard@v.test', ['dentistry'], 'active');
  const ok = await run(await knex('users').where({ id: a.userId }).first());
  assert.equal(ok.err, undefined);
  assert.equal(ok.req.vendorCtx.vendorId, a.vendorId);
  await vendors.setStatus({ userId: adminId }, a.vendorId, 'suspended');
  const blocked = await run(await knex('users').where({ id: a.userId }).first());
  assert.equal(blocked.err.status, 403);
  const none = await run(await knex('users').where({ id: adminId }).first());
  assert.equal(none.err.status, 403);
  assert.deepEqual(await run(null), { redirect: '/login' });
});

test('images are checked by their bytes (PNG/JPEG/WebP only, 1 MB)', async () => {
  assert.equal(vendors.sniffImage(PNG), 'image/png');
  assert.equal(vendors.sniffImage(JPEG), 'image/jpeg');
  assert.equal(vendors.sniffImage(WEBP), 'image/webp');
  assert.equal(vendors.sniffImage(SVG), null);
  assert.equal(vendors.sniffImage(Buffer.from('GIF89a......')), null);
  assert.throws(() => vendors.checkImage({ buffer: SVG, mimetype: 'image/png' }), (e) => Boolean(e.details.image));
  assert.throws(() => vendors.checkImage({ buffer: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]) }), (e) => /1 MB/.test(e.details.image));
  assert.throws(() => vendors.checkImage(null, 'logo', 'too_big'), (e) => /1 MB/.test(e.details.logo));
  assert.equal(vendors.checkImage(null), null);
  assert.deepEqual(vendors.checkImage({ buffer: JPEG }).mime, 'image/jpeg');

  // Pending vendor's image is private; after approval it is public.
  const v = await makeVendor('img@v.test', ['dentistry']);
  const pid = await vendors.saveProduct(v.ctx, null, { name: 'With photo', specialties: ['dentistry'], is_active: '1' }, { data: PNG, mime: 'image/png' });
  assert.equal(await vendors.mediaFile('product', pid, {}), null);
  assert.equal((await vendors.mediaFile('product', pid, { userId: v.userId })).mime, 'image/png');
  assert.ok(await vendors.mediaFile('product', pid, { isPlatformAdmin: true }));
  await vendors.setStatus({ userId: adminId }, v.vendorId, 'active');
  const f = await vendors.mediaFile('product', pid, {});
  assert.equal(f.isPublic, true);
  assert.match(vendors.productImageUrl({ id: pid, image_mime: 'image/png', updated_at: new Date() }), /^\/vendors\/media\/product\/\d+\/[a-z0-9]+\.png$/);
});
