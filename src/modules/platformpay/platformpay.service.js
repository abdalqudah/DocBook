// How clinics and reps pay the platform: bank transfer (IBAN), CliQ, an e-wallet, and cards through PayTabs.
//   • Bank and CliQ details live in the subscriptions settings (shown on every platform invoice); the wallet and the
//     PayTabs profile live here (platform_settings "platform_pay"; the server key encrypted with APP_KEY).
//   • A card payment: platform_payments row → PayTabs hosted page → callback (server, signed) and return (browser,
//     signed) → in both cases the transaction is queried from PayTabs and only an approved one for the exact amount
//     and currency settles the invoice, once (clinic: the subscription period starts; rep: the plan / ad starts).
const crypto = require('crypto');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { AppError, E } = require('../../core/errors');
const { z, validate } = require('../../core/validate');
const paytabs = require('../payments/providers/paytabs');
const subs = require('../subscriptions/subscriptions.service');

const KEY = 'platform_pay';
const DEFAULTS = { walletOn: false, walletName: '', walletNumber: '', walletHolder: '', cardOn: false, ptRegion: 'JOR', ptProfileId: '', ptServerKey: '', ptMode: 'test' };
const BANK_KEYS = ['billingName', 'bankName', 'accountName', 'iban', 'swift', 'cliqAlias', 'cliqName', 'instructions', 'instructions_en'];
const REGIONS = Object.keys(paytabs.REGIONS);

async function settings() {
  return cache.remember('ppay:settings', async () => {
    const row = await knex('platform_settings').where({ key: KEY }).first('value');
    let v = {};
    try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
    const out = { ...DEFAULTS, ...v };
    out.ptServerKey = v.ptServerKeyEnc ? (secrets.decrypt(v.ptServerKeyEnc) || '') : '';
    delete out.ptServerKeyEnc;
    return out;
  }, 15_000);
}

/** Everything a payer may see (never a secret). card: PayTabs is on and complete. */
async function methods() {
  const [s, c] = await Promise.all([settings(), subs.settings()]);
  const bank = c.iban || c.bankName ? { bankName: c.bankName, accountName: c.accountName, iban: c.iban, swift: c.swift } : null;
  const cliq = c.cliqAlias ? { alias: c.cliqAlias, name: c.cliqName } : null;
  const wallet = s.walletOn && s.walletNumber ? { name: s.walletName, number: s.walletNumber, holder: s.walletHolder } : null;
  return { billingName: c.billingName, bank, cliq, wallet, card: Boolean(s.cardOn && s.ptProfileId && s.ptServerKey), cardTest: s.ptMode !== 'live', instructions: c.instructions, instructions_en: c.instructions_en };
}

/** The admin form's view: bank fields from the subscriptions settings; the server key only as "set" + a hint. */
async function adminView() {
  const [s, c] = await Promise.all([settings(), subs.settings()]);
  const { ptServerKey, ...rest } = s;
  return { ...rest, ...Object.fromEntries(BANK_KEYS.map((k) => [k, c[k] || ''])), serverKeySet: Boolean(ptServerKey), serverKeyHint: ptServerKey ? secrets.mask(ptServerKey) : '' };
}

const txt = (max) => z.preprocess((v) => (v === undefined || v === null ? '' : String(v).trim()), z.string().max(max, 'Too long.'));
const on = () => z.preprocess((v) => ['1', 'on', true].includes(v), z.boolean());
async function save(ctx, input) {
  const d = validate(z.object({
    walletOn: on(), walletName: txt(80), walletNumber: txt(60), walletHolder: txt(160),
    cardOn: on(), ptRegion: z.preprocess((v) => v || 'JOR', z.enum(REGIONS, { errorMap: () => ({ message: 'Choose a valid value.' }) })),
    ptProfileId: txt(20).refine((v) => v === '' || /^\d{1,12}$/.test(v), 'Enter a number.'), ptServerKey: txt(200),
    ptMode: z.preprocess((v) => (v === 'live' ? 'live' : 'test'), z.enum(['test', 'live'])),
  }), input);
  const cur = await settings();
  const serverKey = d.ptServerKey || (input.clear_key === '1' ? '' : cur.ptServerKey);
  const errs = {};
  if (d.walletOn && !d.walletNumber) errs.walletNumber = 'Required.';
  if (d.cardOn && !d.ptProfileId) errs.ptProfileId = 'Required.';
  if (d.cardOn && !serverKey) errs.ptServerKey = 'Required.';
  if (Object.keys(errs).length) throw E.validation(errs);
  // Bank and CliQ: the subscriptions settings (the same details print on platform invoices).
  const c = await subs.settings();
  await subs.saveSettings(ctx, { ...c, ...Object.fromEntries(BANK_KEYS.map((k) => [k, input[k] === undefined ? c[k] : input[k]])) });
  const { ptServerKey: _k, ...keep } = d; // eslint-disable-line no-unused-vars
  const value = { ...keep, ptServerKeyEnc: serverKey ? secrets.encrypt(serverKey) : null };
  await knex('platform_settings').insert({ key: KEY, value: JSON.stringify(value) }).onConflict('key').merge({ value: JSON.stringify(value), updated_at: new Date() });
  cache.forgetPrefix('ppay:');
  await audit.record({ ...ctx, businessId: null }, 'platform.payment_methods', { entityType: 'platform_settings', entityId: KEY, newValues: { walletOn: d.walletOn, cardOn: d.cardOn, ptRegion: d.ptRegion, ptMode: d.ptMode, serverKeyChanged: Boolean(d.ptServerKey) } });
}

async function client() {
  const s = await settings();
  if (!s.cardOn || !s.ptProfileId || !s.ptServerKey) return null;
  return paytabs.client({ region: s.ptRegion, profileId: s.ptProfileId, serverKey: s.ptServerKey });
}
async function testConnection() {
  const c = await client();
  if (!c) return { ok: false, message: 'not configured' };
  return c.test();
}

// ---------------------------------------------------------------- card payments
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

/** The invoice being paid, or a refusal. kind 'clinic' → platform_invoices (of that clinic); 'vendor' → vendor_invoices. */
async function invoiceFor(kind, { businessId, vendorId, invoiceId }) {
  if (kind === 'clinic') {
    const inv = await knex('platform_invoices').where({ id: Number(invoiceId) || 0, business_id: businessId }).first();
    return inv ? { id: inv.id, number: inv.number || String(inv.id), amount: r3(inv.amount), currency: inv.currency || 'JOD', open: ['open', 'reported'].includes(inv.status), row: inv } : null;
  }
  const inv = await knex('vendor_invoices').where({ id: Number(invoiceId) || 0, vendor_id: vendorId }).first();
  return inv ? { id: inv.id, number: inv.number, amount: r3(inv.amount), currency: inv.currency || 'JOD', open: ['open', 'reported'].includes(inv.status), row: inv } : null;
}

/** Starts a card payment for an open invoice. → the PayTabs page to send the payer to. */
async function start(kind, { businessId = null, vendorId = null, invoiceId, userId = null, baseUrl, lang = 'ar', customer = {} }) {
  const inv = await invoiceFor(kind, { businessId, vendorId, invoiceId });
  if (!inv) throw E.notFound('Invoice');
  if (!inv.open) throw new AppError('INVOICE_CLOSED', 'This invoice is already closed.', 409);
  if (!(inv.amount > 0)) throw new AppError('INVOICE_CLOSED', 'This invoice is already closed.', 409);
  const c = await client();
  if (!c) throw new AppError('PAY_NOT_CONFIGURED', 'Card payment is not available.', 409);
  const publicId = crypto.randomBytes(12).toString('hex');
  const [id] = await knex('platform_payments').insert({ public_id: publicId, kind, invoice_id: inv.id, business_id: businessId, vendor_id: vendorId, amount: inv.amount, currency: inv.currency, user_id: userId });
  const base = String(baseUrl || '').replace(/\/+$/, '');
  try {
    const r = await c.createPayment({
      cartId: `PP-${publicId}`, amount: inv.amount, currency: inv.currency, description: inv.number, customer, lang,
      callbackUrl: `${base}/pay/platform/callback/${publicId}`, returnUrl: `${base}/pay/platform/return/${publicId}`,
    });
    await knex('platform_payments').where({ id }).update({ provider_ref: r.ref, updated_at: new Date() });
    return { redirectUrl: r.redirectUrl, publicId, amount: inv.amount, currency: inv.currency };
  } catch (e) {
    await knex('platform_payments').where({ id }).update({ status: 'failed', message: String(e.message).slice(0, 250), updated_at: new Date() });
    throw e;
  }
}

/** Marks the invoice paid (once). A clinic's subscription period starts; a rep's plan or ad starts. */
async function settle(p) {
  const won = await knex('platform_payments').where({ id: p.id }).whereNot('status', 'paid').update({ status: 'paid', paid_at: new Date(), updated_at: new Date() });
  if (!won) return 'already';
  const inv = await invoiceFor(p.kind, { businessId: p.business_id, vendorId: p.vendor_id, invoiceId: p.invoice_id });
  const sys = { userId: p.user_id || null, businessId: null };
  if (inv && inv.open) {
    if (p.kind === 'clinic') await subs.recordPayment(sys, p.business_id, { invoice_id: String(inv.id), billing_cycle: inv.row.billing_cycle || 'monthly', amount: '', method: 'card', reference: p.provider_ref });
    else await require('../vendorbilling/billing.service').confirmPayment(sys, inv.id, { method: 'card', reference: p.provider_ref }); // eslint-disable-line global-require
  }
  const who = p.kind === 'clinic' ? (await knex('businesses').where({ id: p.business_id }).first('name')) : (await knex('vendors').where({ id: p.vendor_id }).first('name'));
  await require('../platformnotify/notify.service').admin('card_paid', { who: who ? who.name : '', number: inv ? inv.number : '', amount: `${Number(p.amount)} ${p.currency}` }, { link: p.kind === 'clinic' ? '/admin/subscriptions' : '/admin/vendor-billing?tab=invoices', severity: 'success' }); // eslint-disable-line global-require
  await audit.record({ businessId: p.business_id || null, userId: p.user_id || null }, 'platform.card_payment', { entityType: p.kind === 'clinic' ? 'platform_invoice' : 'vendor_invoice', entityId: p.invoice_id, newValues: { amount: Number(p.amount), currency: p.currency, ref: p.provider_ref } });
  return 'paid';
}

/** Asks PayTabs for the transaction and applies it. → 'paid' | 'already' | 'pending' | 'failed'. */
async function verify(p) {
  if (p.status === 'paid') return 'already';
  const c = await client();
  if (!c || !p.provider_ref) return 'failed';
  const r = await c.verify(p.provider_ref);
  const matches = r.cartId === `PP-${p.public_id}` && r3(r.amount) === r3(p.amount) && String(r.currency || '').toUpperCase() === String(p.currency).toUpperCase();
  if (r.status === 'paid' && matches) return settle(p);
  if (r.status === 'paid' && !matches) {
    await knex('platform_payments').where({ id: p.id }).update({ status: 'failed', result_code: 'MISMATCH', message: 'Amount or currency does not match.', raw: JSON.stringify(r.raw), updated_at: new Date() });
    return 'failed';
  }
  if (r.status === 'pending') return 'pending';
  await knex('platform_payments').where({ id: p.id }).whereNot('status', 'paid').update({ status: r.status === 'cancelled' ? 'cancelled' : 'failed', result_code: r.code || null, message: r.message || null, raw: JSON.stringify(r.raw), updated_at: new Date() });
  return 'failed';
}

const byPublicId = (pid) => knex('platform_payments').where({ public_id: String(pid || '').slice(0, 40) }).first();

async function callback(publicId, rawBody, signature) {
  const p = await byPublicId(publicId);
  if (!p) return { ok: false, status: 404 };
  const c = await client();
  if (!c) return { ok: false, status: 409 };
  if (!c.verifyCallback(rawBody, signature)) return { ok: false, status: 401 };
  let body = null;
  try { body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); } catch { body = null; }
  if (!body || String(body.tran_ref || '') !== String(p.provider_ref)) return { ok: false, status: 400 };
  return { ok: true, result: await verify(p) };
}

async function returned(publicId, fields) {
  const p = await byPublicId(publicId);
  if (!p) return { payment: null, result: 'unknown' };
  const c = await client();
  if (!c) return { payment: p, result: 'failed' };
  if (fields && fields.signature && !c.verifyReturn(fields)) return { payment: p, result: 'failed' };
  try { return { payment: p, result: await verify(p) }; } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { payment: p, result: 'pending' };
  }
}

/** Where the payer goes back to after PayTabs. */
const backUrl = (p, result) => `${p && p.kind === 'vendor' ? '/vendor/billing' : '/app/settings/subscription'}?pay=${['paid', 'already'].includes(result) ? 'paid' : result === 'pending' ? 'pending' : 'failed'}`;

module.exports = { KEY, REGIONS, BANK_KEYS, settings, methods, adminView, save, client, testConnection, start, verify, settle, callback, returned, backUrl, byPublicId };
