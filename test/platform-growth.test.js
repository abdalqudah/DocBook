// The platform's growth tools: subscription invoices e-mailed by themselves (invoice, receipt, one overdue reminder),
// an accepted quotation turned into the clinic's subscription (or a sign-up invitation that links back to the CRM
// contact), onboarding e-mails on day 3 / 7, VAT and currency by the customer's country, two-step sign-in for
// platform admins, server errors told to the admins, and the sales dashboard.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const mailer = require('../src/core/mailer');
const totp = require('../src/core/totp');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const subs = require('../src/modules/subscriptions/subscriptions.service');
const crm = require('../src/modules/crm/crm.service');
const billing = require('../src/modules/sales/billing-mail.service');
const onboarding = require('../src/modules/crm/onboarding-mail.service');
const alerts = require('../src/core/error-alerts');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `pgrow-${k}-${tag}@t.test`;
const real = { send: mailer.send, configured: mailer.configured };
const tick = (ms = 150) => new Promise((ok) => { setTimeout(ok, ms); });
const sys = { businessId: null, userId: null, ip: '127.0.0.1' };
let app; let sent = []; let bid; let ownerId; let planId; let adminId;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  adminId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Growth Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: adminId }).update({ is_platform_admin: true, email_verified_at: new Date() });
  ownerId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Growth Owner', email: mail('o'), password: 'Passw0rd!x' }));
  bid = await knex.transaction((trx) => businesses.create(ownerId, { name: `عيادة النمو ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('businesses').where({ id: bid }).update({ country: 'JO' });
  planId = await subs.savePlan(sys, null, { name: `باقة ${tag}`, name_en: `Plan ${tag}`, price_monthly: '20', price_yearly: '200', currency: 'JOD', max_doctors: '', max_staff: '', max_appointments_month: '', is_active: '1', is_public: '1', sort_order: '99' });
  mailer.send = async (o) => { sent.push(o); return true; };
  mailer.configured = () => true;
  app = await serve();
});
test.after(async () => {
  Object.assign(mailer, real);
  alerts.report.enabledInTests = false;
  await knex('quotes').where('customer_name', 'like', `%${tag}%`).del();
  await knex('crm_contacts').where('name', 'like', `%${tag}%`).orWhere({ business_id: bid }).del();
  await knex('platform_invoices').where({ business_id: bid }).del();
  await knex('subscription_plans').where({ id: planId }).del();
  cache.forgetPrefix('');
  if (app) await app.close();
  await knex.destroy();
});

test('subscription invoices by e-mail: the invoice with its link, the receipt, one overdue reminder', async () => {
  sent = [];
  const business = await knex('businesses').where({ id: bid }).first();
  const invId = await subs.choosePlan({ businessId: bid, userId: ownerId, today: '2026-10-11' }, business, { plan_id: String(planId), billing_cycle: 'monthly' });
  await tick();
  assert.equal(sent.length, 1); assert.equal(sent[0].to, mail('o'));
  const { share_token: token } = await knex('platform_invoices').where({ id: invId }).first('share_token');
  assert.match(sent[0].html, new RegExp(`/invoice/${token}`)); assert.doesNotMatch(sent[0].html, /&lt;br&gt;/);
  // overdue: once
  await knex('platform_invoices').where({ id: invId }).update({ period_start: '2026-01-01' });
  sent = [];
  assert.equal((await billing.runOverdue()).sent >= 1, true);
  assert.ok(sent.some((m) => m.to === mail('o')));
  sent = [];
  await billing.runOverdue();
  assert.ok(!sent.some((m) => m.to === mail('o')), 'reminded once');
  // the receipt
  sent = [];
  await subs.recordPayment({ ...sys, userId: adminId }, bid, { invoice_id: String(invId), billing_cycle: 'monthly', amount: '', method: 'cliq', reference: 'R1' });
  await tick();
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /(Payment received|استلام دفعتك)/);
  assert.equal(await knex('document_sends').where({ doc_type: 'invoice', doc_id: invId }).count({ n: '*' }).then((r) => Number(r[0].n)), 3);
});

test('an accepted quotation: a sign-up invitation for a prospect, linked on sign-up; then the subscription invoice', async () => {
  const [cid] = await knex('crm_contacts').insert({ kind: 'prospect', name: `Prospect ${tag}`, email: mail('p'), country: 'SA', stage: 'interested' });
  const a = app.agent(); await a.login(mail('a'));
  // VAT and currency of the customer's country (Saudi Arabia: 15%, SAR)
  let page = await a.get(`/admin/quotes/new?contact=${cid}&lang=en`);
  assert.match(page.text, /name="tax_rate"[^>]*value="15"/); assert.match(page.text, /name="currency"[^>]*value="SAR"/);
  let r = await a.post('/admin/quotes/new', [['_csrf', a.csrf(page.text)], ['contact_id', String(cid)], ['customer_name', `Prospect ${tag}`], ['customer_email', mail('p')], ['item_description', 'Pro yearly'], ['item_quantity', '1'], ['item_price', '1000']]);
  const qid = Number(r.location.split('/').pop());
  let q = await knex('quotes').where({ id: qid }).first();
  assert.equal(q.currency, 'SAR'); assert.equal(Number(q.tax_rate), 15); assert.equal(Number(q.total), 1150);
  await knex('quotes').where({ id: qid }).update({ status: 'accepted', responded_at: new Date(), response_name: 'P' });
  page = await a.get(`/admin/quotes/${qid}?lang=en`);
  assert.match(page.text, /data-quote-activate/); assert.match(page.text, /Send the sign-up link/);
  sent = [];
  r = await a.post(`/admin/quotes/${qid}/invite`, { _csrf: a.csrf(page.text) });
  assert.equal(r.status, 302); assert.equal(sent.length, 1);
  assert.match(sent[0].html, new RegExp(`/signup\\?email=${encodeURIComponent(mail('p')).replace(/[.]/g, '\\.')}`));
  const signup = await app.agent().get(`/signup?email=${encodeURIComponent(mail('p'))}&lang=en`);
  assert.match(signup.text, new RegExp(`value="${mail('p').replace(/[.]/g, '\\.')}"`));
  // they sign up with the same e-mail: the same CRM contact
  const pUser = await knex.transaction((trx) => auth.createUser(trx, { name: 'Prospect Owner', email: mail('p'), password: 'Passw0rd!x' }));
  const pBid = await knex.transaction((trx) => businesses.create(pUser, { name: `عيادة العميل ${tag}`, currency: 'SAR', timezone: 'Asia/Riyadh' }, trx));
  await crm.sync();
  assert.equal((await knex('crm_contacts').where({ id: cid }).first('business_id')).business_id, pBid);
  assert.equal(await knex('crm_contacts').where({ business_id: pBid }).count({ n: '*' }).then((x) => Number(x[0].n)), 1, 'no duplicate contact');
  page = await a.get(`/admin/quotes/${qid}?lang=en`);
  assert.match(page.text, /Issue the subscription invoice/);
  sent = [];
  r = await a.post(`/admin/quotes/${qid}/activate`, { _csrf: a.csrf(page.text), plan_id: String(planId), billing_cycle: 'yearly', branches: '1' });
  assert.equal(r.status, 302);
  await tick();
  const inv = await knex('platform_invoices').where({ business_id: pBid, status: 'open' }).first();
  assert.ok(inv); assert.equal(inv.billing_cycle, 'yearly');
  assert.ok(sent.some((m) => m.to === mail('p')), 'the invoice is e-mailed');
  await knex('platform_invoices').where({ business_id: pBid }).del();
  await knex('crm_contacts').where({ id: cid }).del();
  await knex('businesses').where({ id: pBid }).update({ status: 'suspended' });
});

test('onboarding e-mails: the step that is due, once; old clinics are left alone', async () => {
  await knex('lifecycle_emails').where({ business_id: bid }).del();
  await knex('businesses').where({ id: bid }).update({ created_at: new Date(Date.now() - 4 * 86_400_000), status: 'active' });
  sent = [];
  await onboarding.runDue();
  const mine = () => sent.filter((m) => m.to === mail('o'));
  assert.equal(mine().length, 1); assert.equal(mine()[0].kind, 'onboarding');
  sent = [];
  await onboarding.runDue();
  assert.equal(mine().length, 0, 'once');
  assert.deepEqual(await knex('lifecycle_emails').where({ business_id: bid }).pluck('step'), ['day3_setup']);
  // 8 days: day 7 is due
  await knex('businesses').where({ id: bid }).update({ created_at: new Date(Date.now() - 8 * 86_400_000) });
  await onboarding.runDue();
  assert.equal(mine().length, 1);
  // an old clinic: nothing
  await knex('lifecycle_emails').where({ business_id: bid }).del();
  await knex('businesses').where({ id: bid }).update({ created_at: new Date(Date.now() - 40 * 86_400_000) });
  sent = [];
  await onboarding.runDue();
  assert.equal(mine().length, 0);
});

test('two-step sign-in for a platform admin: set up, then every sign-in asks for the code; a code works once', async () => {
  const email = mail('tfa');
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'TFA Admin', email, password: 'Passw0rd!x' }));
  await knex('users').where({ id: uid }).update({ is_platform_admin: true, email_verified_at: new Date() });
  const a = app.agent(); await a.login(email);
  let page = await a.get('/admin/security?lang=en');
  assert.equal(page.status, 200); assert.match(page.text, /data-admin-settings/);
  await a.post('/admin/security/start', { _csrf: a.csrf(page.text) });
  page = await a.get('/admin/security?lang=en');
  const secret = page.text.match(/data-tfa-secret>([A-Z2-7]+)</)[1];
  assert.match(page.text, /<svg/);
  let r = await a.post('/admin/security/enable', { _csrf: a.csrf(page.text), code: '000000' });
  assert.equal(r.status, 422);
  const step = totp.stepOf();
  r = await a.post('/admin/security/enable', { _csrf: a.csrf(page.text), code: totp.codeAt(secret, step) });
  assert.equal(r.status, 200); assert.match(r.text, /data-tfa-codes/);
  const recovery = r.text.match(/[0-9A-F]{5}-[0-9A-F]{5}/g);
  assert.equal(recovery.length, 10);
  const row = await knex('users').where({ id: uid }).first();
  assert.ok(row.totp_enabled_at); assert.doesNotMatch(row.totp_secret_enc, new RegExp(secret));

  // a new sign-in stops at the code
  const b = app.agent();
  const login = await b.get('/login?lang=en');
  r = await b.post('/login', { _csrf: b.csrf(login.text), email, password: 'Passw0rd!x' });
  assert.equal(r.location, '/login/2fa');
  r = await b.get('/admin');
  assert.notEqual(r.status, 200, 'the admin is closed until the code');
  const form = await b.get('/login/2fa?lang=en');
  assert.equal(form.status, 200);
  r = await b.post('/login/2fa', { _csrf: b.csrf(form.text), code: '123456' });
  assert.equal(r.status, 422);
  r = await b.post('/login/2fa', { _csrf: b.csrf(form.text), code: totp.codeAt(secret, step) });
  assert.equal(r.status, 422, 'the code used to set it up is not accepted again');
  r = await b.post('/login/2fa', { _csrf: b.csrf(form.text), code: totp.codeAt(secret, step + 1) });
  assert.equal(r.status, 302);
  assert.equal((await b.get('/admin?lang=en')).status, 200);
  // a recovery code, once
  const c = app.agent();
  const l2 = await c.get('/login?lang=en');
  await c.post('/login', { _csrf: c.csrf(l2.text), email, password: 'Passw0rd!x' });
  const f2 = await c.get('/login/2fa?lang=en');
  r = await c.post('/login/2fa', { _csrf: c.csrf(f2.text), code: recovery[0] });
  assert.equal(r.status, 302);
  const d = app.agent();
  const l3 = await d.get('/login?lang=en');
  await d.post('/login', { _csrf: d.csrf(l3.text), email, password: 'Passw0rd!x' });
  const f3 = await d.get('/login/2fa?lang=en');
  assert.equal((await d.post('/login/2fa', { _csrf: d.csrf(f3.text), code: recovery[0] })).status, 422, 'a recovery code works once');
  await knex('users').where({ id: uid }).update({ is_platform_admin: false, status: 'disabled' });
});

test('server errors are told to the platform admins, at most once in 30 minutes; the sales dashboard', async () => {
  alerts.report.enabledInTests = true; alerts.report.reset();
  const before = Number((await knex('platform_notifications').where({ kind: 'server_error' }).count({ n: '*' }))[0].n);
  alerts.report({ method: 'GET', originalUrl: '/app/x/12345' }, new Error('boom'));
  alerts.report({ method: 'GET', originalUrl: '/app/y' }, new Error('boom 2'));
  await tick(300);
  const after = Number((await knex('platform_notifications').where({ kind: 'server_error' }).count({ n: '*' }))[0].n);
  assert.equal(after - before, 1);
  alerts.report.enabledInTests = false;
  await knex('platform_notifications').where({ kind: 'server_error' }).orderBy('id', 'desc').limit(1).del();

  const a = app.agent(); await a.login(mail('a'));
  const page = await a.get('/admin/sales-dashboard?lang=en');
  assert.equal(page.status, 200); assert.match(page.text, /data-mrr/); assert.match(page.text, /data-by-month/);
  const r = await a.get('/admin/sales-profile?lang=en');
  assert.match(r.text, /data-country-rates/); assert.match(r.text, /name="rate_tax_SA" value="15"/);
});
