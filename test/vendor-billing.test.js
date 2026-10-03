// Reps billing: free trial, plan limits (visit requests, offers, clinics per offer), invoices and payment
// confirmation, offer targeting by chosen clinics / cities, and paid ads shown to doctors.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const scheduling = require('../src/modules/clinic/scheduling');
const vendors = require('../src/modules/vendors/vendor.service');
const market = require('../src/modules/marketplace/market.service');
const reps = require('../src/modules/marketplace/rep-visits.service');
const billing = require('../src/modules/vendorbilling/billing.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const today = scheduling.clinicNow('Asia/Amman').date;
const admin = { userId: null, businessId: null };
let app; let vendor; let vctx; let repEmail; let adminEmail; let plan; let trialPlan; let a; let b; let c;

async function clinic(name, specialty, city) {
  const email = `${name.toLowerCase().replace(/\W+/g, '')}${tag}@vb.test`;
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman', specialty }, trx);
    return id;
  });
  const { last_business_id: id } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id }).update({ specialty, city, status: 'active', onboarding_completed_at: new Date(), directory_listed: true, rep_requests_off: false });
  const business = await knex('businesses').where({ id }).first();
  return { email, ctx: { businessId: id, userId, today, timezone: 'Asia/Amman' }, business };
}
const setBilling = async (v) => {
  await knex('platform_settings').insert({ key: billing.KEY, value: JSON.stringify(v) }).onConflict('key').merge();
  cache.forgetPrefix('vbill:');
};
const seen = async (cl) => (await market.offers(cl.ctx, cl.business)).map((o) => o.id);

test.before(async () => {
  await knex.migrate.latest();
  app = await serve();
  a = await clinic('Amman Dental', 'dentistry', 'Amman');
  b = await clinic('Irbid Dental', 'dentistry', 'Irbid');
  c = await clinic('Amman Skin', 'dermatology', 'Amman');
  const [vid] = await knex('vendors').insert({ type: 'rep', name: `Rep Co ${tag}`, email: `repco${tag}@vb.test`, phone: '0790000000', status: 'active' });
  vendor = await knex('vendors').where({ id: vid }).first();
  repEmail = `rep${tag}@vb.test`;
  const uid = await auth.createUser(knex, { name: 'Rep', email: repEmail, password: 'Passw0rd!x' });
  await knex('vendor_users').insert({ vendor_id: vid, user_id: uid, role: 'owner' });
  vctx = { vendorId: vid, userId: uid };
  adminEmail = `admin${tag}@vb.test`;
  admin.userId = await auth.createUser(knex, { name: 'Admin', email: adminEmail, password: 'Passw0rd!x' });
  await knex('users').where({ id: admin.userId }).update({ is_platform_admin: true });
  [trialPlan] = await knex('vendor_plans').insert({ name: `Trial ${tag}`, price_monthly: 0, currency: 'JOD', max_requests_month: 1, max_offers_month: 1, max_offer_clinics: 1, ad_days_month: 3, is_active: true, is_public: false });
  [plan] = await knex('vendor_plans').insert({ name: `Pro ${tag}`, price_monthly: 25, price_yearly: 250, currency: 'JOD', max_requests_month: 50, max_offers_month: 20, max_offer_clinics: 5, ad_days_month: 0, is_active: true, is_public: true });
});

test.after(async () => {
  await knex('platform_settings').where({ key: billing.KEY }).del();
  cache.forgetPrefix('vbill:');
  await app.close();
  await knex.destroy();
});

test('billing off: no limits, nothing blocked', async () => {
  await knex('platform_settings').where({ key: billing.KEY }).del(); cache.forgetPrefix('vbill:');
  const st = await billing.assertCan(vendor.id, 'request');
  assert.equal(st.enabled, false);
  assert.equal(await billing.maxOfferClinics(vendor.id), null);
});

test('trial: limits of the trial plan apply; requests and offers stop at the monthly limit', async () => {
  await setBilling({ ...billing.DEFAULTS, enabled: true, trialDays: 14, trialPlanId: trialPlan, adPricePerDay: 2 });
  await knex('vendor_subscriptions').where({ vendor_id: vendor.id }).del();
  const st = await billing.state(vendor.id);
  assert.equal(st.status, 'trialing');
  assert.equal(st.daysLeft, 14);
  assert.equal(st.limits.requests, 1);
  await knex('rep_visits').insert({ business_id: a.ctx.businessId, vendor_id: vendor.id, user_id: vctx.userId, visit_date: today, visit_time: '10:00', duration_minutes: 15, purpose: 'Intro', status: 'requested' });
  await assert.rejects(reps.book(vctx, vendor, { business_id: a.ctx.businessId }), (e) => e.code === 'VENDOR_LIMIT_REQUESTS');
  // Offers: the first publish passes, the second is over the monthly limit.
  const first = await vendors.saveOffer(vctx, null, { title: 'Offer one', specialties: ['dentistry'], target: 'specialty' }, null, { publish: true, vendorStatus: 'active', today });
  assert.equal(first.status, 'published');
  await assert.rejects(vendors.saveOffer(vctx, null, { title: 'Offer two', specialties: ['dentistry'] }, null, { publish: true, vendorStatus: 'active', today }), (e) => e.code === 'VENDOR_LIMIT_OFFERS');
  // A draft is fine; sending it to two clinics is over the trial's one clinic per offer.
  await assert.rejects(vendors.saveOffer(vctx, null, { title: 'Two clinics', target: 'clinics', clinic_ids: [a.ctx.businessId, b.ctx.businessId] }, null, {}), (e) => e.code === 'VENDOR_LIMIT_CLINICS');
});

test('expired trial blocks requests, offers and ads until a plan is paid; confirming starts the period', async () => {
  await knex('vendor_subscriptions').where({ vendor_id: vendor.id }).update({ status: 'trialing', trial_ends_at: '2020-01-01' });
  const st = await billing.state(vendor.id);
  assert.equal(st.status, 'expired');
  await assert.rejects(billing.assertCan(vendor.id, 'offer'), (e) => e.code === 'VENDOR_SUB_EXPIRED');
  await assert.rejects(billing.createAd(vctx, { title: 'Ad', starts_on: today, days: 1 }), (e) => e.code === 'VENDOR_SUB_EXPIRED');
  const invId = await billing.choosePlan(vctx, plan, 'yearly');
  const inv = await knex('vendor_invoices').where({ id: invId }).first();
  assert.equal(Number(inv.amount), 250);
  assert.match(inv.number, /^VN-\d{4}-\d{6}$/);
  await billing.reportPayment(vctx, invId, { method: 'cliq', reference: 'TX-1' });
  assert.equal((await knex('vendor_invoices').where({ id: invId }).first()).status, 'reported');
  await billing.confirmPayment(admin, invId);
  const after = await billing.state(vendor.id);
  assert.equal(after.status, 'active');
  assert.equal(after.plan.id, plan);
  assert.equal(String(after.sub.current_period_start), today);
  assert.ok(after.ok);
  await assert.rejects(billing.confirmPayment(admin, invId), (e) => e.code === 'INVOICE_CLOSED');
});

test('offer targeting: chosen clinics only, or specialty limited to cities; targeted clinics are notified', async () => {
  const toA = await vendors.saveOffer(vctx, null, { title: 'Only for A', target: 'clinics', clinic_ids: [a.ctx.businessId] }, null, { publish: true, vendorStatus: 'active', today });
  const irbid = await vendors.saveOffer(vctx, null, { title: 'Irbid dentists', target: 'specialty', specialties: ['dentistry'], cities: 'irbid' }, null, { publish: true, vendorStatus: 'active', today });
  const sa = await seen(a); const sb = await seen(b); const sc = await seen(c);
  assert.ok(sa.includes(toA.id) && !sb.includes(toA.id) && !sc.includes(toA.id));
  assert.ok(sb.includes(irbid.id) && !sa.includes(irbid.id) && !sc.includes(irbid.id));
  await assert.rejects(market.offer(b.ctx, b.business, toA.id), (e) => e.status === 404);
  const n = await knex('notifications').where({ business_id: a.ctx.businessId, type: 'vendor_offer.sent' }).first('id');
  assert.ok(n);
  const own = await vendors.ownOffer(vctx, irbid.id);
  assert.deepEqual(own.cities, ['irbid']);
  // A clinic id not open to reps is refused.
  await assert.rejects(vendors.saveOffer(vctx, null, { title: 'Bad', target: 'clinics', clinic_ids: [999999999] }, null, {}), (e) => e.code === 'VALIDATION_FAILED');
});

test('ads: priced per day, invoiced, shown to matching clinics after payment; impressions and clicks counted', async () => {
  const ad = await billing.createAd(vctx, { title: 'Implant week', starts_on: today, days: 3, specialties: ['dentistry'], cities: 'Amman' });
  assert.equal(ad.price, 6);
  assert.equal(ad.status, 'pending_payment');
  assert.equal((await billing.adsFor(a.business, { limit: 5 })).filter((x) => x.id === ad.id).length, 0);
  const inv = await knex('vendor_invoices').where({ ad_id: ad.id }).first();
  await billing.confirmPayment(admin, inv.id);
  const shownA = await billing.adsFor(a.business, { limit: 5 });
  assert.ok(shownA.some((x) => x.id === ad.id));
  assert.ok(!(await billing.adsFor(b.business, { limit: 5 })).some((x) => x.id === ad.id)); // Irbid
  assert.ok(!(await billing.adsFor(c.business, { limit: 5 })).some((x) => x.id === ad.id)); // skin clinic
  await billing.adClick(ad.id);
  const row = await knex('vendor_ads').where({ id: ad.id }).first('impressions', 'clicks');
  assert.ok(row.impressions >= 1);
  assert.equal(row.clicks, 1);
  await billing.moderateAd(admin, ad.id, 'reject', 'Not allowed');
  assert.ok(!(await billing.adsFor(a.business, { limit: 5 })).some((x) => x.id === ad.id));
});

test('pages: rep billing, ads, offer form; admin tabs; clinic sees the sponsored card', async () => {
  const r = app.agent(); await r.login(repEmail);
  for (const p of ['/vendor/billing', '/vendor/ads', '/vendor/ads/new', '/vendor/offers/new']) {
    const res = await r.get(p);
    assert.equal(res.status, 200, p);
  }
  assert.match((await r.get('/vendor/offers/new')).text, /name="target" value="clinics"/);
  const choose = await r.submit('/vendor/billing', '/vendor/billing/choose', { plan_id: String(plan), cycle: 'monthly' });
  assert.equal(choose.status, 302);
  const ad = await r.submit('/vendor/ads/new', '/vendor/ads', { title: 'Free?', starts_on: today, days: '2' });
  assert.equal(ad.status, 302);
  const ad2 = await knex('vendor_ads').where({ vendor_id: vendor.id, title: 'Free?' }).first('id');
  const inv = await knex('vendor_invoices').where({ ad_id: ad2.id }).first('id');
  await billing.confirmPayment(admin, inv.id);
  const m = app.agent(); await m.login(adminEmail);
  for (const tab of ['invoices', 'ads', 'vendors', 'plans', 'settings']) assert.equal((await m.get(`/admin/vendor-billing?tab=${tab}`)).status, 200, tab);
  const save = await m.submit('/admin/vendor-billing?tab=settings', '/admin/vendor-billing/settings', { enabled: '1', trialDays: '30', adPricePerDay: '2', adMaxDays: '60', adCurrency: 'JOD', trialPlanId: String(trialPlan) });
  assert.equal(save.status, 302);
  assert.equal((await billing.settings()).trialDays, 30);
  const d = app.agent(); await d.login(a.email);
  const mk = await d.get('/app/marketplace');
  assert.equal(mk.status, 200);
  assert.match(mk.text, /vb-ad/);
  const go = await d.get(`/app/marketplace/ad/${ad2.id}`);
  assert.equal(go.status, 302);
});
