// Paying the platform: payment methods (bank / CliQ / wallet / PayTabs) and card payments of a clinic's subscription
// invoice and a rep's invoice through PayTabs (stubbed — no network): signatures, server-side verification, amount
// checks, one settlement however many callbacks.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const http = require('../src/modules/payments/providers/http');
const subs = require('../src/modules/subscriptions/subscriptions.service');
const ppay = require('../src/modules/platformpay/platformpay.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const KEY = 'PT-SERVER-KEY-PLATFORM';
const admin = { userId: null, businessId: null };
const sim = { tx: {} };
let app; let vendorId; let businessId; let planId; let repEmail; let ownerEmail; let savedSubs;
const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
async function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  assert.equal(opts.headers.authorization, KEY);
  const j = JSON.parse(opts.body);
  if (u.pathname === '/payment/request') {
    const ref = `TST${Object.keys(sim.tx).length + 1}${tag}`;
    sim.tx[ref] = { ref, cart_id: j.cart_id, amount: j.cart_amount, currency: j.cart_currency, status: 'P', callback: j.callback, ret: j.return };
    return reply({ tran_ref: ref, redirect_url: `https://secure-jordan.paytabs.com/payment/page/${ref}` });
  }
  if (u.pathname === '/payment/query') {
    const t = sim.tx[j.tran_ref];
    if (!t) return reply({ message: 'Invalid tran_ref' }, 400);
    return reply({ tran_ref: t.ref, cart_id: t.cart_id, cart_amount: String(t.paidAmount || t.amount), cart_currency: t.currency, tran_type: 'Sale', payment_result: { response_status: t.status, response_message: t.status === 'A' ? 'Authorised' : 'Declined' } });
  }
  return reply({ message: 'not found' }, 404);
}
const sign = (body) => crypto.createHmac('sha256', KEY).update(body).digest('hex');
const refOf = (redirectUrl) => redirectUrl.split('/').pop();

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  http.setFetch(fakeFetch);
  app = await serve();
  savedSubs = await subs.settings();
  repEmail = `rp${tag}@pp.test`;
  const uid = await auth.createUser(knex, { name: 'Rep', email: repEmail, password: 'Passw0rd!x' });
  [vendorId] = await knex('vendors').insert({ type: 'rep', name: `Pay Rep ${tag}`, email: `prep${tag}@pp.test`, status: 'active' });
  await knex('vendor_users').insert({ vendor_id: vendorId, user_id: uid, role: 'owner' });
  ownerEmail = `ow${tag}@pp.test`;
  const oid = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: ownerEmail, password: 'Passw0rd!x' });
    await businesses.create(id, { name: `Pay Clinic ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  ({ last_business_id: businessId } = await knex('users').where({ id: oid }).first('last_business_id'));
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  [planId] = await knex('subscription_plans').insert({ name: `Pro ${tag}`, price_monthly: 30, price_yearly: 300, currency: 'JOD' });
});
test.after(async () => {
  await knex('platform_settings').where({ key: ppay.KEY }).del();
  await subs.saveSettings(admin, savedSubs);
  cache.forgetPrefix('');
  http.setFetch(null);
  await app.close();
  await knex.destroy();
});

test('payment methods: bank, CliQ, wallet and PayTabs saved; the server key is encrypted and never shown', async () => {
  await ppay.save(admin, { cardOn: '1', ptRegion: 'JOR', ptProfileId: '12345', ptServerKey: KEY, ptMode: 'test', walletOn: '1', walletName: 'Zain Cash', walletNumber: '0791112223', walletHolder: 'Platform Co', iban: 'JO71CBJO0000000000001234567890', bankName: 'Bank X', cliqAlias: 'PLATFORM', cliqName: 'Platform Co' });
  const m = await ppay.methods();
  assert.equal(m.card, true);
  assert.equal(m.bank.iban, 'JO71CBJO0000000000001234567890');
  assert.equal(m.cliq.alias, 'PLATFORM');
  assert.equal(m.wallet.number, '0791112223');
  const raw = (await knex('platform_settings').where({ key: ppay.KEY }).first('value')).value;
  assert.ok(!raw.includes(KEY), 'server key stored encrypted');
  assert.equal((await ppay.adminView()).ptServerKey, undefined);
  // Saving again without a key keeps it; the subscriptions settings form (without bank fields) keeps the IBAN.
  await ppay.save(admin, { cardOn: '1', ptRegion: 'JOR', ptProfileId: '12345', ptServerKey: '', walletOn: '1', walletName: 'Zain Cash', walletNumber: '0791112223' });
  assert.equal((await ppay.settings()).ptServerKey, KEY);
  const cur = await subs.settings();
  await subs.saveSettings(admin, { enabled: cur.enabled ? '1' : '', trialDays: String(cur.trialDays), graceDays: String(cur.graceDays), trialNoCard: '1' });
  assert.equal((await subs.settings()).iban, 'JO71CBJO0000000000001234567890');
  await assert.rejects(ppay.save(admin, { cardOn: '1', ptProfileId: '' }), { code: 'VALIDATION_FAILED' });
});

test('a rep pays its invoice by card: bad signature refused, verified with PayTabs, settled once', async () => {
  const [invId] = await knex('vendor_invoices').insert({ number: `VN-PP-${tag}`.slice(0, 30), vendor_id: vendorId, kind: 'plan', description: 'Plan', amount: 12.5, currency: 'JOD', billing_cycle: 'monthly' });
  const r = await ppay.start('vendor', { vendorId, invoiceId: invId, baseUrl: 'https://app.test' });
  const ref = refOf(r.redirectUrl);
  assert.equal(sim.tx[ref].callback, `https://app.test/pay/platform/callback/${r.publicId}`);
  assert.equal(Number(sim.tx[ref].amount), 12.5);
  const body = JSON.stringify({ tran_ref: ref, cart_id: `PP-${r.publicId}` });
  assert.equal((await ppay.callback(r.publicId, Buffer.from(body), 'bad')).status, 401);
  assert.equal((await ppay.callback(r.publicId, Buffer.from(body), sign(body))).result, 'pending');
  sim.tx[ref].status = 'A';
  assert.equal((await ppay.callback(r.publicId, Buffer.from(body), sign(body))).result, 'paid');
  assert.equal((await ppay.returned(r.publicId, {})).result, 'already');
  const inv = await knex('vendor_invoices').where({ id: invId }).first();
  assert.equal(inv.status, 'paid');
  assert.equal(inv.method, 'card');
  assert.equal(inv.reference, ref);
  assert.equal((await knex('vendor_subscriptions').where({ vendor_id: vendorId }).first()).status, 'active');
  await assert.rejects(ppay.start('vendor', { vendorId, invoiceId: invId, baseUrl: 'https://app.test' }), { code: 'INVOICE_CLOSED' });
});

test('an approved transaction for another amount does not pay the invoice', async () => {
  const [invId] = await knex('vendor_invoices').insert({ number: `VN-PQ-${tag}`.slice(0, 30), vendor_id: vendorId, kind: 'plan', description: 'Plan', amount: 40, currency: 'JOD' });
  const r = await ppay.start('vendor', { vendorId, invoiceId: invId, baseUrl: 'https://app.test' });
  const ref = refOf(r.redirectUrl);
  Object.assign(sim.tx[ref], { status: 'A', paidAmount: 1 });
  assert.equal((await ppay.returned(r.publicId, {})).result, 'failed');
  assert.equal((await knex('vendor_invoices').where({ id: invId }).first()).status, 'open');
});

test('a clinic pays its subscription invoice by card; the period starts', async () => {
  const [invId] = await knex('platform_invoices').insert({ business_id: businessId, plan_id: planId, plan_name: 'Pro', billing_cycle: 'monthly', amount: 30, currency: 'JOD', status: 'open', branches: 1 });
  await expect404Other(invId);
  const r = await ppay.start('clinic', { businessId, invoiceId: invId, baseUrl: 'https://app.test' });
  const ref = refOf(r.redirectUrl);
  sim.tx[ref].status = 'A';
  const out = await ppay.returned(r.publicId, {});
  assert.equal(out.result, 'paid');
  assert.equal(ppay.backUrl(out.payment, out.result), '/app/settings/subscription?pay=paid');
  const inv = await knex('platform_invoices').where({ id: invId }).first();
  assert.equal(inv.status, 'paid');
  assert.equal(inv.method, 'card');
  const sub = await knex('clinic_subscriptions').where({ business_id: businessId }).first();
  assert.equal(sub.status, 'active');
  assert.ok(sub.current_period_end);
  assert.ok(await knex('platform_notifications').where({ kind: 'card_paid' }).first('id'));
});
async function expect404Other(invId) {
  await assert.rejects(ppay.start('clinic', { businessId: businessId + 999999, invoiceId: invId, baseUrl: 'https://x' }), { code: 'NOT_FOUND' });
}

test('pages: admin payment methods, rep billing shows card + wallet, return route redirects', async () => {
  const [invId] = await knex('vendor_invoices').insert({ number: `VN-PR-${tag}`.slice(0, 30), vendor_id: vendorId, kind: 'ad', description: 'Ad', amount: 9, currency: 'JOD' });
  const r = app.agent(); await r.login(repEmail);
  const page = await r.get('/vendor/billing');
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`/vendor/billing/invoices/${invId}/card`));
  assert.match(page.text, /0791112223/);
  const go = await r.submit('/vendor/billing', `/vendor/billing/invoices/${invId}/card`, {});
  assert.equal(go.status, 303);
  assert.match(go.location, /^https:\/\/secure-jordan\.paytabs\.com\/payment\/page\//);
  const pid = (await knex('platform_payments').where({ invoice_id: invId, kind: 'vendor' }).first('public_id')).public_id;
  const back = await r.post(`/pay/platform/return/${pid}`, { tranRef: 'x' });
  assert.equal(back.status, 303);
  assert.equal(back.location, '/vendor/billing?pay=pending');
  const admEmail = `adm${tag}@pp.test`;
  const aid = await auth.createUser(knex, { name: 'A', email: admEmail, password: 'Passw0rd!x' });
  await knex('users').where({ id: aid }).update({ is_platform_admin: true });
  const m = app.agent(); await m.login(admEmail);
  const ap = await m.get('/admin/payments');
  assert.equal(ap.status, 200);
  assert.ok(!ap.text.includes(KEY));
  assert.match(ap.text, /JO71CBJO/);
});
