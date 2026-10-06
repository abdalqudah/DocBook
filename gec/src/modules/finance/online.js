// Online card payments through Stripe Checkout. The student pays on Stripe's hosted page (card details never touch
// this server); a payment is recorded only when Stripe's signed webhook says the checkout was paid — never from the
// browser coming back — and each checkout is recorded once. Not connected until Settings → Payments has the keys.
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const secrets = require('../../core/secrets');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const settings = require('../settings/settings.service');
const money = require('./money');

const API = 'https://api.stripe.com/v1';
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']); // Stripe: amount in thousandths, multiple of 10
const SYSTEM = { employee: { id: null, dataScope: 'all', branchId: null, roleKey: 'system' } };

let fetchImpl = (...a) => fetch(...a);
/** Tests: replace the HTTP client. */
const useFetch = (fn) => { fetchImpl = fn; };

async function currentConfig() {
  const s = await settings.get('integration.stripe');
  if (!s || !s.enabled || !s.secret_key_enc) return null;
  return { secretKey: secrets.decrypt(s.secret_key_enc), webhookSecret: s.webhook_secret_enc ? secrets.decrypt(s.webhook_secret_enc) : null };
}

/** Amount in the currency's smallest unit, as Stripe expects it. */
function toMinor(amount, currency) {
  const c = String(currency).toUpperCase();
  if (ZERO_DECIMAL.has(c)) return Math.round(Number(amount));
  if (THREE_DECIMAL.has(c)) return money.cents(amount) * 10;
  return money.cents(amount);
}
function fromMinor(minor, currency) {
  const c = String(currency).toUpperCase();
  if (ZERO_DECIMAL.has(c)) return Number(minor);
  if (THREE_DECIMAL.has(c)) return money.fromCents(Math.round(Number(minor) / 10));
  return money.fromCents(Number(minor));
}

/** Stripe's form encoding (nested objects as a[b][c]=v). */
function encode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue; // eslint-disable-line no-continue
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out); else out.append(key, String(v));
  }
  return out;
}

async function call(path, { method = 'GET', params, key, idempotencyKey } = {}) {
  const c = key ? { secretKey: key } : await currentConfig();
  if (!c) throw new AppError('PAYMENTS_NOT_CONNECTED', 'Online payments are not connected.', 409);
  const res = await fetchImpl(`${API}${path}`, {
    method, signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${c.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: method === 'GET' ? undefined : encode(params || {}).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError('PAYMENT_PROVIDER_ERROR', (json.error && json.error.message) || `Stripe error ${res.status}`, 502);
  return json;
}

/** Checks the keys (Settings → Payments → Test). */
async function test(key) { const b = await call('/balance', { key }); return { livemode: !!b.livemode }; }

const balanceOf = (inv) => money.fromCents(money.cents(inv.total) - money.cents(inv.paid));
const payable = (inv) => ['issued', 'partially_paid'].includes(inv.status) && balanceOf(inv) > 0;

/** Starts a Stripe Checkout for the invoice's open balance; returns the hosted page address. */
async function startCheckout(inv, { locale = 'en' } = {}) {
  if (!payable(inv)) throw E.conflict('NOT_PAYABLE', 'This invoice has nothing left to pay.');
  const amount = balanceOf(inv);
  const base = `${config.appUrl}/invoices/${inv.public_token}`;
  const session = await call('/checkout/sessions', {
    method: 'POST', idempotencyKey: `inv-${inv.id}-${money.cents(amount)}-${Math.floor(Date.now() / 600000)}`,
    params: {
      mode: 'payment', success_url: `${base}?paid=1`, cancel_url: `${base}?cancelled=1`, locale: locale === 'ar' ? 'auto' : 'en',
      client_reference_id: String(inv.id), customer_email: inv.bill_to_email || undefined,
      line_items: { 0: { quantity: 1, price_data: { currency: inv.currency.toLowerCase(), unit_amount: toMinor(amount, inv.currency), product_data: { name: `Invoice ${inv.number}` } } } },
      metadata: { invoice_id: String(inv.id), invoice_number: inv.number },
      payment_intent_data: { metadata: { invoice_id: String(inv.id), invoice_number: inv.number } },
    },
  });
  await knex('payment_sessions').insert({ invoice_id: inv.id, provider: 'stripe', session_id: session.id, amount, currency: inv.currency, status: 'open' });
  return session.url;
}

/** Stripe-Signature: t=timestamp,v1=hex(hmac_sha256(secret, `${t}.${body}`)); 5-minute tolerance. */
function validSignature(secret, rawBody, header, now = Date.now()) {
  if (!secret || !header || !Buffer.isBuffer(rawBody)) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  const sigs = String(header).split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

/** Records a paid checkout once. Returns 'recorded' | 'duplicate' | 'unknown' | 'needs_review'. */
async function recordPaid(session) {
  const ps = await knex('payment_sessions').where({ session_id: session.id }).first();
  if (!ps) return 'unknown';
  // Claim the session atomically so a retried webhook cannot record the payment twice.
  const claimed = await knex('payment_sessions').where({ id: ps.id, status: 'open' }).update({ status: 'paid', provider_payment_id: session.payment_intent || null, updated_at: new Date() });
  if (!claimed) return 'duplicate';
  const paid = session.amount_total != null ? fromMinor(session.amount_total, ps.currency) : Number(ps.amount);
  const finance = require('./invoices.service'); // eslint-disable-line global-require
  const ctx = { userId: null, ip: null, actor: 'stripe' };
  try {
    const p = await finance.recordPayment(ctx, SYSTEM, { invoice_id: ps.invoice_id, amount: paid, method: 'online', reference: String(session.payment_intent || session.id).slice(0, 120), notes: 'Paid online by card (Stripe Checkout).' });
    await knex('payment_sessions').where({ id: ps.id }).update({ payment_id: p.id });
    return 'recorded';
  } catch (e) {
    // e.g. the balance was settled another way meanwhile: the money was taken, so a person must reconcile / refund.
    await audit.record(ctx, 'payment.online_needs_review', { entityType: 'invoice', entityId: ps.invoice_id, newValues: { session: session.id, amount: paid, reason: e.message } });
    const notify = require('../notifications/service'); // eslint-disable-line global-require
    const handlers = await knex('users as u').join('employees as e', 'e.user_id', 'u.id').join('role_permissions as rp', 'rp.role_id', 'e.role_id').where('rp.permission', 'finance.manage').where('u.status', 'active').distinct('u.id');
    for (const h of handlers) await notify.toUser(h.id, { category: 'payments', title: { key: 'finance.online_review', vars: { amount: paid, currency: ps.currency } }, href: `/staff/invoices/${ps.invoice_id}` }); // eslint-disable-line no-await-in-loop
    return 'needs_review';
  }
}

async function handleEvent(event) {
  const obj = (event.data && event.data.object) || {};
  if ((event.type === 'checkout.session.completed' && obj.payment_status === 'paid') || event.type === 'checkout.session.async_payment_succeeded') return recordPaid(obj);
  if (event.type === 'checkout.session.expired') { await knex('payment_sessions').where({ session_id: obj.id, status: 'open' }).update({ status: 'expired', updated_at: new Date() }); return 'expired'; }
  if (event.type === 'checkout.session.async_payment_failed') { await knex('payment_sessions').where({ session_id: obj.id, status: 'open' }).update({ status: 'failed', updated_at: new Date() }); return 'failed'; }
  return 'ignored';
}

module.exports = { currentConfig, test, startCheckout, validSignature, handleEvent, recordPaid, payable, balanceOf, toMinor, fromMinor, encode, useFetch };
