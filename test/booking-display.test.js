// Public booking display: prices hidden unless the clinic turns them on (never "0"), the square logo for square
// places, and a doctor's own online-consultation settings (on/off, price, payment link) shown to patients.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const tele = require('../src/modules/telehealth/telehealth.service');
const { pricesShown } = require('../src/modules/site/portal.web');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a2c80000000049454e44ae426082', 'hex');
let app; let ctx; let slug; let email; let docId;

test.before(async () => {
  await knex.migrate.latest();
  app = await serve();
  email = `bd${tag}@bd.test`;
  const uid = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Dr Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name: `Display Clinic ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: bid } = await knex('users').where({ id: uid }).first('last_business_id');
  slug = `bd-${tag}`;
  await knex('businesses').where({ id: bid }).update({ slug, onboarding_completed_at: new Date(), booking_enabled: true, status: 'active' });
  businesses.forget(bid);
  ctx = { businessId: bid, userId: uid, permissions: await rbac.getUserPermissions(bid, uid), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null };
  docId = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. Zero', slot_duration_minutes: '30', consultation_fee: '0', base_salary: '0', is_active: '1' });
  await knex('memberships').where({ business_id: bid, user_id: uid }).update({ doctor_id: docId });
});
test.after(async () => { await app.close(); await knex.destroy(); });

test('prices are off unless the clinic turns them on; a new clinic starts with them off', async () => {
  const b = await knex('businesses').where({ id: ctx.businessId }).first('prices_on_site', 'prices_on_booking');
  assert.equal(Boolean(b.prices_on_site), false);
  assert.equal(Boolean(b.prices_on_booking), false);
  assert.equal(pricesShown({}, 'booking'), false);
  assert.equal(pricesShown({ prices_on_booking: 1 }, 'booking'), true);
  const page = await app.agent().get(`/${slug}/book`);
  assert.equal(page.status, 200);
  assert.ok(!/0\.000|JOD 0|0 JOD/.test(page.text.replace(/<script[\s\S]*?<\/script>/g, '')), 'no price on the booking page');
});

test('square logo: uploaded separately, served for square places, used as the browser icon', async () => {
  await businesses.setAppearance(ctx, { square: PNG, squareMime: 'image/png' });
  businesses.forget(ctx.businessId);
  const b = await businesses.get(ctx.businessId);
  assert.ok(b.logo_square_mime);
  assert.match(businesses.markUrl(b, `/${slug}`), new RegExp(`^/${slug}/logo-square\\?v=`));
  const r = await app.agent().get(`/${slug}/logo-square`);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'image/png');
  await knex('businesses').where({ id: ctx.businessId }).update({ favicon_mode: 'logo' });
  const f = await businesses.faviconFile(ctx.businessId);
  assert.equal(f.mime, 'image/png');
  const book = await app.agent().get(`/${slug}/book`);
  assert.match(book.text, new RegExp(`/${slug}/logo-square\\?v=`));
});

test('a doctor manages their own online consultations: on/off, price, payment link', async () => {
  await assert.rejects(async () => tele.parseDoctorOnline({ online_enabled: '1', online_pay_link: 'http://pay.example/x' }), { code: 'VALIDATION_FAILED' });
  const a = app.agent(); await a.login(email);
  const page = await a.get('/app/telehealth/mine');
  assert.equal(page.status, 200);
  assert.match(page.text, /name="online_pay_link"/);
  const r = await a.submit('/app/telehealth/mine', '/app/telehealth/mine', { online_form: '1', online_enabled: '1', online_fee: '15', online_method: 'builtin', online_pay_link: 'https://pay.example/dr-zero' });
  assert.equal(r.status, 302);
  const d = await knex('doctors').where({ id: docId }).first('online_enabled', 'online_fee', 'online_pay_link');
  assert.equal(Boolean(d.online_enabled), true);
  assert.equal(Number(d.online_fee), 15);
  assert.equal(d.online_pay_link, 'https://pay.example/dr-zero');
  assert.equal(Boolean((await knex('businesses').where({ id: ctx.businessId }).first('online_enabled')).online_enabled), true, 'the clinic opens online consultations');
  businesses.forget(ctx.businessId);
  const list = await tele.onlineDoctors(await businesses.get(ctx.businessId), 'en');
  const me = list.find((x) => x.id === docId);
  assert.equal(me.ownFee, true);
  assert.equal(me.payLink, 'https://pay.example/dr-zero');
  const online = await app.agent().get(`/${slug}/book/online`);
  assert.equal(online.status, 200);
  assert.match(online.text, /15/);
});
