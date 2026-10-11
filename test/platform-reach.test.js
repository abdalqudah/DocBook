// Reaching and keeping clinics: country pages (/in/sa) with prices in the country's currency and sign-up preset to
// it; referrals (a free month for the inviting clinic when the invited one pays); the owner's recommendation score
// (NPS) with low scores told to the admins; the help center (/help, admin, the clinic's Help page); the activity page
// refreshes itself and reads the visitor's address behind a local proxy.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const subs = require('../src/modules/subscriptions/subscriptions.service');
const cpages = require('../src/modules/countrypages/countrypages.service');
const referrals = require('../src/modules/referrals/referrals.service');
const feedback = require('../src/modules/feedback/feedback.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `preach-${k}-${tag}@t.test`;
const sys = { businessId: null, userId: null, ip: '127.0.0.1' };
let app; let savedPages; let planId; let aBid; let aOwner;

async function clinic(k, name) {
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: `Owner ${k}`, email: mail(k), password: 'Passw0rd!x' }));
  const bid = await knex.transaction((trx) => businesses.create(uid, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('users').where({ id: uid }).update({ email_verified_at: new Date() });
  await knex('businesses').where({ id: bid }).update({ onboarding_completed_at: new Date() });
  return { uid, bid };
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  savedPages = await knex('platform_settings').where({ key: cpages.KEY }).first();
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'Reach Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  planId = await subs.savePlan(sys, null, { name: `باقة ${tag}`, name_en: `Reach ${tag}`, price_monthly: '20', price_yearly: '200', currency: 'JOD', max_doctors: '', max_staff: '', max_appointments_month: '', is_active: '1', is_public: '1', sort_order: '98' });
  ({ uid: aOwner, bid: aBid } = await clinic('a1', `عيادة الداعية ${tag}`));
  app = await serve();
});
test.after(async () => {
  await knex('platform_settings').where({ key: cpages.KEY }).del();
  if (savedPages) await knex('platform_settings').insert(savedPages);
  await knex('help_articles').where('slug', 'like', `%${tag}%`).del();
  await knex('subscription_plans').where({ id: planId }).del();
  cache.forgetPrefix('');
  if (app) await app.close();
  await knex.destroy();
});

test('a country page: off by default; on, the plans in its currency and sign-up preset to the country', async () => {
  await knex('platform_settings').where({ key: cpages.KEY }).del(); cache.forgetPrefix(''); // off until switched on
  assert.equal((await app.agent().get('/in/sa')).status, 404);
  const a = app.agent(); await a.login(mail('a'));
  const form = await a.get('/admin/country-pages?lang=en');
  assert.equal(form.status, 200);
  let r = await a.post('/admin/country-pages', { _csrf: a.csrf(form.text), SA_on: '1', SA_currency: 'SAR', SA_rate: 'x' });
  assert.equal(r.status, 422);
  r = await a.post('/admin/country-pages', { _csrf: a.csrf(form.text), SA_on: '1', SA_currency: 'SAR', SA_rate: '5.29', SA_title_en: `Clinics in Saudi ${tag}` });
  assert.equal(r.status, 302);
  cache.forgetPrefix('');
  const page = await app.agent().get('/in/sa?lang=en');
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`Clinics in Saudi ${tag}`)); assert.match(page.text, /data-country-page="SA"/);
  assert.match(page.text, /lp-amount num">110<\/span><span class="lp-cur">SAR/, '20 JOD × 5.29 → rounded up to 110 SAR');
  assert.match(page.text, /href="\/signup\?country=SA"/);
  assert.equal((await app.agent().get('/in/SA')).status, 301);
  const signup = await app.agent().get('/signup?country=SA&lang=en');
  assert.match(signup.text, /<option value="Asia\/Riyadh" selected/); assert.match(signup.text, /<option value="SAR" selected/);
  assert.equal(cpages.convert(20, 5.29), 110); assert.equal(cpages.convert(200, 5.29), 1060);
});

test('referrals: the invitation link, the invited clinic marked; its first payment gives the inviter a free month, once', async () => {
  const code = await referrals.codeFor(aBid);
  assert.match(code, /^[A-Z0-9]{8}$/); assert.equal(await referrals.codeFor(aBid), code);
  // the link through sign-up
  const v = app.agent();
  const page = await v.get(`/signup?ref=${code}&lang=en`);
  const r = await v.post('/signup', { _csrf: v.csrf(page.text), name: 'Invited Owner', email: mail('inv'), password: 'Passw0rd!x7', clinic_name: `عيادة مدعوّة ${tag}`, currency: 'JOD', timezone: 'Asia/Amman', terms: 'on' });
  assert.equal(r.status, 302);
  const invited = await knex('businesses').where({ name: `عيادة مدعوّة ${tag}` }).first('id', 'referred_by');
  assert.equal(invited.referred_by, aBid);
  // the inviter is on an active period: one month added when the invited clinic pays
  await subs.ensure(await knex('businesses').where({ id: aBid }).first(), '2026-10-11');
  await knex('clinic_subscriptions').where({ business_id: aBid }).update({ status: 'active', current_period_end: '2026-12-15' });
  await subs.ensure(await knex('businesses').where({ id: invited.id }).first(), '2026-10-11');
  await subs.recordPayment(sys, invited.id, { plan_id: String(planId), billing_cycle: 'monthly', amount: '20', method: 'cash' });
  const sub = await knex('clinic_subscriptions').where({ business_id: aBid }).first('current_period_end');
  assert.equal(new Date(sub.current_period_end).toISOString().slice(0, 10) >= '2027-01-14', true);
  assert.equal((await knex('referral_rewards').where({ referred_id: invited.id }).first()).applied, 'period');
  await subs.recordPayment(sys, invited.id, { plan_id: String(planId), billing_cycle: 'monthly', amount: '20', method: 'cash' });
  assert.equal(await knex('referral_rewards').where({ referrer_id: aBid }).count({ n: '*' }).then((x) => Number(x[0].n)), 1, 'once per invited clinic');
  // the inviter sees it on the subscription page (shown while subscriptions are on)
  const savedSubs = await subs.settings();
  await subs.saveSettings(sys, { ...savedSubs, trialDays: 30, graceDays: 7, enabled: '1', trialNoCard: '1' });
  const o = app.agent(); await o.login(mail('a1'));
  const s = await o.get('/app/settings/subscription?lang=en');
  await subs.saveSettings(sys, { ...savedSubs, enabled: savedSubs.enabled ? '1' : '', trialNoCard: savedSubs.trialNoCard ? '1' : '' });
  assert.match(s.text, /data-referral/); assert.match(s.text, new RegExp(`/signup\\?ref=${code}`)); assert.match(s.text, /1 signed up · 1 free months earned/);
  assert.equal(referrals.addMonth('2026-01-31'), '2026-02-28');
});

test('the recommendation score: asked of an owner after 30 days; a low score reaches the admins and the CRM', async () => {
  const o = app.agent(); await o.login(mail('a1'));
  await knex('nps_responses').where({ business_id: aBid }).del();
  await knex('businesses').where({ id: aBid }).update({ created_at: new Date(Date.now() - 5 * 86_400_000) });
  cache.forgetPrefix('');
  let page = await o.get('/app?lang=en');
  assert.doesNotMatch(page.text, /data-nps/, 'not before 30 days');
  await knex('businesses').where({ id: aBid }).update({ created_at: new Date(Date.now() - 40 * 86_400_000) });
  cache.forgetPrefix('');
  page = await o.get('/app?lang=en');
  assert.match(page.text, /data-nps/);
  await o.post('/app/feedback', { _csrf: o.csrf(page.text), later: '1' });
  page = await o.get('/app?lang=en');
  assert.doesNotMatch(page.text, /data-nps/, '"not now" asks again later');
  await knex('nps_responses').where({ business_id: aBid }).update({ created_at: new Date(Date.now() - 20 * 86_400_000) });
  page = await o.get('/app?lang=en');
  assert.match(page.text, /data-nps/);
  const before = Number((await knex('platform_notifications').where({ kind: 'nps_low' }).count({ n: '*' }))[0].n);
  await o.post('/app/feedback', { _csrf: o.csrf(page.text), score: '4', comment: 'Too slow on reports' });
  assert.equal((await knex('nps_responses').where({ business_id: aBid }).orderBy('id', 'desc').first('score')).score, 4);
  assert.equal(Number((await knex('platform_notifications').where({ kind: 'nps_low' }).count({ n: '*' }))[0].n) - before, 1);
  page = await o.get('/app?lang=en');
  assert.doesNotMatch(page.text, /data-nps/);
  const sc = await feedback.score();
  assert.ok(sc.n >= 1);
});

test('the help center: written in admin, public at /help, in the clinic Help page; drafts stay hidden', async () => {
  const a = app.agent(); await a.login(mail('a'));
  const form = await a.get('/admin/help/new?lang=en');
  let r = await a.post('/admin/help/new', { _csrf: a.csrf(form.text), title_ar: '', body_ar: '' });
  assert.equal(r.status, 422);
  r = await a.post('/admin/help/new', { _csrf: a.csrf(form.text), title_ar: `إضافة طبيب ${tag}`, title_en: `Add a doctor ${tag}`, slug: `add-doctor-${tag}`, category: 'start', body_ar: '# الخطوات\n- افتح الأطباء\n<script>x</script>', published: '1' });
  assert.equal(r.status, 302);
  r = await a.post('/admin/help/new', { _csrf: a.csrf(form.text), title_ar: `مسودة ${tag}`, slug: `draft-${tag}`, body_ar: 'نص', published: '0' });
  const pub = await app.agent().get('/help?lang=en');
  assert.equal(pub.status, 200); assert.match(pub.text, new RegExp(`/help/add-doctor-${tag}`)); assert.doesNotMatch(pub.text, new RegExp(`draft-${tag}`));
  const art = await app.agent().get(`/help/add-doctor-${tag}`);
  assert.equal(art.status, 200); assert.match(art.text, /<h2>الخطوات<\/h2>/); assert.doesNotMatch(art.text, /<script>x/);
  assert.equal((await app.agent().get(`/help/draft-${tag}`)).status, 404);
  const o = app.agent(); await o.login(mail('a1'));
  const inApp = await o.get('/app/help?lang=en');
  assert.equal(inApp.status, 200); assert.match(inApp.text, /data-help-guides/); assert.match(inApp.text, new RegExp(`/help/add-doctor-${tag}`));
});

test('the activity page refreshes itself and says so', async () => {
  const a = app.agent(); await a.login(mail('a'));
  const page = await a.get('/admin/activity?lang=en');
  assert.equal(page.status, 200); assert.match(page.text, /data-activity-live/); assert.match(page.text, /js\/activity\.js/);
});
