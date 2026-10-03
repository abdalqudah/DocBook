// Online payment before confirmation (online consultations): the clinic's card gateway (PayTabs or HyperPay),
// payment attempts, server-side verification, turning a verified payment into the normal invoice, refunds and
// releasing the slots of bookings that were never paid.
//
// Rules that matter:
//  • the browser is never trusted: every result is asked from the provider's server (PayTabs /payment/query,
//    HyperPay GET /v1/checkouts/{id}/payment), and the PayTabs callback/return signatures are checked too;
//  • the verified amount and currency must equal the payment row, otherwise nothing is marked paid;
//  • idempotent: a payment row goes to "paid" with one conditional UPDATE; only the caller that won it issues the
//    invoice (appointments.service.checkout, method "card"), so a second callback never makes a second invoice;
//  • no card data is stored — only the provider's references and result codes.
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { z, validate, optionalString } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const appts = require('../clinic/appointments.service');
const notifications = require('../notifications/notification.service');
const paytabs = require('./providers/paytabs');
const hyperpay = require('./providers/hyperpay');

const PROVIDERS = ['none', 'paytabs', 'hyperpay'];
const MODES = ['test', 'live'];
const REGIONS = Object.keys(paytabs.REGIONS);
const STATUSES = ['initiated', 'paid', 'failed', 'cancelled', 'refunded'];
const PAGE_LIFETIME_MIN = 30;   // a started payment keeps the booking held this long (provider pages expire ~30 min)
const DEFAULT_HOLD_MIN = 30;

// ---------------------------------------------------------------- gateway settings
async function gatewayRow(businessId) {
  return knex('payment_gateways').where({ business_id: businessId }).first();
}

/** The gateway with its credentials decrypted (server-side only), or a "none" gateway. */
async function gateway(businessId) {
  const row = await gatewayRow(businessId);
  if (!row) return { provider: 'none', mode: 'test', creds: {}, holdMinutes: DEFAULT_HOLD_MIN, row: null };
  return { provider: row.provider, mode: row.mode, creds: secrets.decrypt(row.credentials_enc) || {}, holdMinutes: Number(row.hold_minutes), row };
}

/** A provider client for the gateway, or null when the gateway is off or incomplete. */
function clientOf(gw, currency) {
  try {
    if (gw.provider === 'paytabs') return paytabs.client(gw.creds);
    if (gw.provider === 'hyperpay') return hyperpay.client({ ...gw.creds, mode: gw.mode, currency });
  } catch (e) {
    if (e.code !== 'PAY_NOT_CONFIGURED') throw e;
  }
  return null;
}

/** What the settings page shows: never a secret, only whether it is set and a masked hint. */
async function gatewayView(businessId) {
  const gw = await gateway(businessId);
  const c = gw.creds || {};
  return {
    provider: gw.provider, mode: gw.mode, holdMinutes: gw.holdMinutes, region: c.region || 'JOR', profileId: c.profileId || '',
    serverKeySet: Boolean(c.serverKey), serverKeyHint: c.serverKey ? secrets.mask(c.serverKey) : '',
    entityCard: c.entityCard || '', entityMada: c.entityMada || '',
    accessTokenSet: Boolean(c.accessToken), accessTokenHint: c.accessToken ? secrets.mask(c.accessToken) : '',
    ready: Boolean(clientOf(gw, 'JOD')), testedAt: gw.row ? gw.row.tested_at : null, testOk: gw.row ? gw.row.test_ok : null,
    unreadable: Boolean(gw.row && gw.row.credentials_enc && !secrets.decrypt(gw.row.credentials_enc)),
  };
}

const idText = (max) => z.preprocess((v) => (v === undefined || v === null ? '' : String(v).trim()), z.string().max(max, 'Too long.'));
const gatewaySchema = z.object({
  provider: z.enum(PROVIDERS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  mode: z.preprocess((v) => v || 'test', z.enum(MODES, { errorMap: () => ({ message: 'Choose a valid value.' }) })),
  hold_minutes: z.preprocess((v) => (v === '' || v === undefined ? DEFAULT_HOLD_MIN : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(0, 'Too small.').max(1440, 'Too large.')),
  pt_region: z.preprocess((v) => v || 'JOR', z.enum(REGIONS, { errorMap: () => ({ message: 'Choose a valid value.' }) })),
  pt_profile_id: idText(20).refine((v) => v === '' || /^\d{1,12}$/.test(v), 'Enter a number.'),
  pt_server_key: idText(200),
  hp_entity_card: idText(64).refine((v) => v === '' || /^[A-Za-z0-9]{8,64}$/.test(v), 'Choose a valid value.'),
  hp_entity_mada: idText(64).refine((v) => v === '' || /^[A-Za-z0-9]{8,64}$/.test(v), 'Choose a valid value.'),
  hp_access_token: idText(400),
  clear_secrets: optionalString(5),
});

/** Saves the gateway. Secret fields left empty keep the stored value (they are never sent back to the browser). */
async function saveGateway(ctx, input) {
  const d = validate(gatewaySchema, input);
  const cur = await gateway(ctx.businessId);
  const keep = d.provider === cur.provider && d.clear_secrets !== '1' ? cur.creds : {};
  let creds = {};
  if (d.provider === 'paytabs') {
    creds = { region: d.pt_region, profileId: d.pt_profile_id, serverKey: d.pt_server_key || keep.serverKey || '' };
    const errs = {};
    if (!creds.profileId) errs.pt_profile_id = 'Required.';
    if (!creds.serverKey) errs.pt_server_key = 'Required.';
    if (Object.keys(errs).length) throw E.validation(errs);
  } else if (d.provider === 'hyperpay') {
    creds = { entityCard: d.hp_entity_card, entityMada: d.hp_entity_mada || '', accessToken: d.hp_access_token || keep.accessToken || '' };
    const errs = {};
    if (!creds.entityCard) errs.hp_entity_card = 'Required.';
    if (!creds.accessToken) errs.hp_access_token = 'Required.';
    if (Object.keys(errs).length) throw E.validation(errs);
  }
  const row = {
    provider: d.provider, mode: d.mode, hold_minutes: d.hold_minutes, credentials_enc: d.provider === 'none' ? null : secrets.encrypt(creds),
    updated_by: ctx.userId || null, updated_at: new Date(),
    ...(JSON.stringify(creds) !== JSON.stringify(cur.creds) || d.provider !== cur.provider || d.mode !== cur.mode ? { tested_at: null, test_ok: null } : {}),
  };
  if (cur.row) await knex('payment_gateways').where({ id: cur.row.id }).update(row);
  else await knex('payment_gateways').insert({ business_id: ctx.businessId, ...row });
  await audit.record(ctx, 'payments.gateway_updated', {
    entityType: 'clinic', entityId: ctx.businessId,
    oldValues: { provider: cur.provider, mode: cur.mode, hold_minutes: cur.holdMinutes },
    newValues: { provider: d.provider, mode: d.mode, hold_minutes: d.hold_minutes, credentials: d.provider === 'none' ? 'removed' : '[updated]' },
  });
}

/** "Test connection": a harmless call with the stored credentials. */
async function testGateway(ctx, currency) {
  const gw = await gateway(ctx.businessId);
  const client = clientOf(gw, currency);
  if (!client) throw new AppError('PAY_NOT_CONFIGURED', 'The payment gateway is not set up.', 409);
  let result;
  try { result = await client.test(); } catch (e) { result = { ok: false, message: e.message }; }
  await knex('payment_gateways').where({ business_id: ctx.businessId }).update({ tested_at: new Date(), test_ok: result.ok });
  await audit.record(ctx, 'payments.gateway_tested', { entityType: 'clinic', entityId: ctx.businessId, newValues: { provider: gw.provider, ok: result.ok } });
  return result;
}

// ---------------------------------------------------------------- helpers
const newPublicId = () => crypto.randomBytes(24).toString('base64url');
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{32}$/;
const round3 = (v) => Math.round(Number(v) * 1000) / 1000;
const samePrice = (a, b, provider) => (provider === 'hyperpay' ? Number(a).toFixed(2) === Number(b).toFixed(2) : round3(a) === round3(b));

/** Only the non-sensitive parts of a provider answer (the clients already pick fields; this caps the size). */
const rawJson = (raw) => (raw ? JSON.stringify(raw).slice(0, 8000) : null);

const byPublicId = (pid) => (PUBLIC_ID_RE.test(String(pid || '')) ? knex('payments').where({ public_id: String(pid) }).first() : Promise.resolve(null));

/** A context for work done without a signed-in user (provider callbacks, the interval job). */
const systemCtx = (businessId, env = {}) => ({
  businessId, userId: null, permissions: new Set(), ip: env.ip || null, userAgent: env.userAgent || null, locale: env.locale || 'ar',
  timezone: env.timezone, baseUrl: env.baseUrl || config.appUrl,
});

/** Whether the clinic can take online payments for this consultation right now. */
async function onlineOption(clinic, row) {
  const gw = await gateway(clinic.id);
  const client = clientOf(gw, clinic.currency);
  if (!client) return null;
  const brands = gw.provider === 'hyperpay' ? ['card', ...(gw.creds.entityMada ? ['mada'] : [])] : ['card'];
  return { provider: gw.provider, mode: gw.mode, brands, holdMinutes: gw.holdMinutes, client, gw, payable: Number(row.amount_due) > 0 };
}

const lastPayment = (businessId, apptId) => knex('payments').where({ business_id: businessId, appointment_id: apptId }).orderBy('id', 'desc').first();
const paymentsOf = (businessId, apptId) => knex('payments').where({ business_id: businessId, appointment_id: apptId }).orderBy('id', 'desc');

// ---------------------------------------------------------------- start a payment
/**
 * Starts a payment for an online consultation awaiting payment (from the patient's /c/<token> page).
 * @param clinic  businesses row
 * @param row     telehealth consultation row (tele.byToken)
 * @param o       { brand, baseUrl, locale, stateOf }
 * @returns the payments row plus { redirectUrl } (PayTabs) or { widget } (HyperPay)
 */
async function start(clinic, row, { brand = 'card', baseUrl, locale = 'ar', state, env = {} }) {
  if (state !== 'awaiting_payment') throw new AppError('PAY_NOT_DUE', 'Nothing to pay for this booking.', 409);
  const opt = await onlineOption(clinic, row);
  if (!opt) throw new AppError('PAY_NOT_CONFIGURED', 'Online payment is not available.', 409);
  if (!opt.payable) throw new AppError('PAY_NOT_DUE', 'Nothing to pay for this booking.', 409);
  if (!opt.brands.includes(brand)) brand = 'card'; // eslint-disable-line no-param-reassign
  // HyperPay takes 2 decimals: the amount is rounded once here, so what is charged, stored and invoiced is the same
  // (12.345 JOD → 12.35, not a 12.35 charge against a 12.345 invoice).
  const amount = opt.provider === 'hyperpay' ? Math.round(Number((Number(row.amount_due) * 100).toPrecision(12))) / 100 : round3(row.amount_due);
  const currency = String(clinic.currency || 'JOD').toUpperCase();
  const publicId = newPublicId();
  const cartId = `DB${row.appointment_id}-${publicId.slice(0, 10)}`;
  const base = String(baseUrl || config.appUrl).replace(/\/+$/, '');
  // Older unfinished attempts of this booking are closed (they are still verified if the provider reports them).
  await knex('payments').where({ business_id: clinic.id, appointment_id: row.appointment_id, status: 'initiated' }).update({ status: 'cancelled', updated_at: new Date() });
  const [id] = await knex('payments').insert({
    business_id: clinic.id, appointment_id: row.appointment_id, public_id: publicId, provider: opt.provider, mode: opt.mode, brand,
    amount, currency, status: 'initiated', cart_id: cartId,
  });
  const customer = { name: row.patient_name, email: row.patient_email, phone: row.patient_phone, country: row.patient_country || undefined };
  const clinicName = (locale === 'en' && clinic.name_en) || clinic.name;
  try {
    if (opt.provider === 'paytabs') {
      const r = await opt.client.createPayment({
        cartId, amount, currency, description: `${clinicName} · #${row.appointment_id}`, customer, lang: locale,
        callbackUrl: `${base}/pay/callback/paytabs/${publicId}`, returnUrl: `${base}/pay/return/paytabs/${publicId}`,
      });
      await knex('payments').where({ id }).update({ provider_ref: r.ref, provider_payment_id: r.ref, raw_result: JSON.stringify({ redirect_url: r.redirectUrl }), updated_at: new Date() });
      await audit.record(systemCtx(clinic.id, env), 'payment.started', { entityType: 'appointment', entityId: row.appointment_id, newValues: { payment: id, provider: 'paytabs', amount, currency } });
      return { id, publicId, provider: 'paytabs', redirectUrl: r.redirectUrl };
    }
    const r = await opt.client.createPayment({ cartId, amount, currency, brand, customer });
    await knex('payments').where({ id }).update({ provider_ref: r.ref, updated_at: new Date() });
    await audit.record(systemCtx(clinic.id, env), 'payment.started', { entityType: 'appointment', entityId: row.appointment_id, newValues: { payment: id, provider: 'hyperpay', brand, amount, currency } });
    return { id, publicId, provider: 'hyperpay', checkoutId: r.ref, integrity: r.integrity, widgetUrl: opt.client.widgetUrl(r.ref), widgetOrigin: opt.client.base, brandList: hyperpay.BRANDS[brand] };
  } catch (e) {
    await knex('payments').where({ id }).update({ status: 'failed', result_message: String(e.message).slice(0, 250), updated_at: new Date() });
    throw e;
  }
}

// ---------------------------------------------------------------- verification & settlement
/**
 * Applies a VERIFIED provider result to a payment row. Idempotent.
 * @param v  { status: paid|pending|failed|cancelled, amount, currency, code, message, paymentId, raw }
 * @returns 'paid' | 'already' | 'pending' | 'failed' | 'mismatch'
 */
async function applyResult(p, v, env = {}) {
  const now = new Date();
  const base = { result_code: v.code ? String(v.code).slice(0, 40) : null, raw_result: rawJson(v.raw), updated_at: now };
  if (v.status === 'pending') {
    await knex('payments').where({ id: p.id, status: 'initiated' }).update(base);
    return 'pending';
  }
  if (v.status !== 'paid') {
    await knex('payments').where({ id: p.id }).whereIn('status', ['initiated', 'cancelled']).update({ ...base, status: v.status === 'cancelled' ? 'cancelled' : 'failed', result_message: v.message || null });
    return 'failed';
  }
  if (!samePrice(v.amount, p.amount, p.provider) || String(v.currency || '').toUpperCase() !== String(p.currency).toUpperCase()) {
    await knex('payments').where({ id: p.id }).whereIn('status', ['initiated', 'cancelled', 'failed']).update({ ...base, status: 'failed', note: 'mismatch', result_message: `amount/currency mismatch: ${v.amount} ${v.currency}` });
    await audit.record(systemCtx(p.business_id, env), 'payment.mismatch', { entityType: 'appointment', entityId: p.appointment_id, newValues: { payment: p.id, expected: `${p.amount} ${p.currency}`, reported: `${v.amount} ${v.currency}` } });
    await notifications.notify(p.business_id, { permission: 'billing.manage', type: 'payment.problem', severity: 'danger', title: `#${p.appointment_id} · ${v.amount} ${v.currency}`, body: bilingual('payments.notify.mismatch'), link: `/app/payments/${p.id}` });
    return 'mismatch';
  }
  const claimed = await knex('payments').where({ id: p.id }).whereIn('status', ['initiated', 'cancelled', 'failed']).whereNull('note')
    .update({ ...base, status: 'paid', paid_at: now, result_message: v.message || null, ...(v.paymentId ? { provider_payment_id: String(v.paymentId).slice(0, 120) } : {}) });
  if (!claimed) return 'already';
  await settle(p.id, env);
  return 'paid';
}

const bilingual = (key, vars) => `${translator('ar')(key, vars)} · ${translator('en')(key, vars)}`;

/**
 * Turns a paid payment into the invoice and confirms the consultation (only once: guarded by invoice_id/note).
 * A payment that arrives for a booking that is already paid or no longer active is kept and flagged for a refund.
 */
async function settle(paymentId, env = {}) {
  const lock = await knex('payments').where({ id: paymentId, status: 'paid' }).whereNull('invoice_id').whereNull('note').update({ note: 'settling', updated_at: new Date() });
  if (!lock) return null;
  const p = await knex('payments').where({ id: paymentId }).first();
  const a = await knex('appointments').where({ id: p.appointment_id, business_id: p.business_id }).first();
  const clinic = await knex('businesses').where({ id: p.business_id }).first('timezone', 'currency');
  const ctx = systemCtx(p.business_id, { ...env, timezone: clinic && clinic.timezone });
  const flag = async (note) => {
    await knex('payments').where({ id: p.id }).update({ note, updated_at: new Date() });
    await audit.record(ctx, 'payment.needs_attention', { entityType: 'appointment', entityId: p.appointment_id, newValues: { payment: p.id, note } });
    await notifications.notify(p.business_id, { permission: 'billing.manage', type: 'payment.problem', severity: 'warning', title: `${a ? a.patient_name : '#'} · ${Number(p.amount)} ${p.currency}`, body: bilingual(`payments.notify.${note}`), link: `/app/payments/${p.id}` });
    return note;
  };
  if (!a) return flag('late');
  if (a.payment_status === 'paid') return flag('duplicate');
  if (['cancelled', 'no_show', 'completed'].includes(a.status)) return flag('late');
  let invId;
  try {
    invId = await appts.checkout(ctx, a.id, { amount_paid: Number(p.amount), payment_method: 'card', discount_percent: 0 });
  } catch (e) {
    if (e.code === 'ALREADY_PAID') return flag('duplicate');
    await knex('payments').where({ id: p.id }).update({ note: null }); // let the job try again
    throw e;
  }
  // checkout() completes the visit; a consultation paid in advance stays open until the call.
  await knex('appointments').where({ id: a.id, business_id: p.business_id }).update({ status: a.status, with_doctor: a.with_doctor, updated_at: new Date() });
  await knex('payments').where({ id: p.id }).update({ invoice_id: invId, note: null, updated_at: new Date() });
  await audit.record(ctx, 'payment.paid', { entityType: 'appointment', entityId: a.id, newValues: { payment: p.id, provider: p.provider, amount: Number(p.amount), currency: p.currency, invoice: invId } });
  await notifications.notify(p.business_id, { permission: 'appointments.manage', type: 'payment.received', severity: 'info', title: `${a.patient_name} · ${Number(p.amount)} ${p.currency}`, body: bilingual('payments.notify.paid'), link: `/app/appointments/${a.id}` });
  if (a.status === 'pending') {
    try {
      await appts.setStatus(ctx, a.id, 'confirmed'); // e-mails the consultation link (telehealth hook) when mail is set up
    } catch (e) { console.error('[payments] confirm failed:', e.message); } // eslint-disable-line no-console
  }
  return 'settled';
}

/** Asks the provider for the real state of a payment and applies it. */
async function verify(p, env = {}) {
  const gw = await gateway(p.business_id);
  if (gw.provider !== p.provider) throw new AppError('PAY_NOT_CONFIGURED', 'The payment gateway changed.', 409);
  const client = clientOf(gw, p.currency);
  if (!client) throw new AppError('PAY_NOT_CONFIGURED', 'The payment gateway is not set up.', 409);
  if (!p.provider_ref) return 'failed';
  const v = p.provider === 'paytabs' ? await client.verify(p.provider_ref) : await client.verify(p.provider_ref, p.brand || 'card');
  if (p.provider === 'paytabs' && v.ref && v.ref !== p.provider_ref) return 'failed';
  if (v.cartId && v.cartId !== p.cart_id) return 'failed'; // an answer about another transaction
  return applyResult(p, v, env);
}

/** PayTabs server callback: signature over the raw body, then the state is re-read from PayTabs. */
async function paytabsCallback(publicId, rawBody, signature, env = {}) {
  const p = await byPublicId(publicId);
  if (!p || p.provider !== 'paytabs') return { ok: false, status: 404 };
  const gw = await gateway(p.business_id);
  const client = clientOf(gw, p.currency);
  if (!client || gw.provider !== 'paytabs') return { ok: false, status: 409 };
  if (!client.verifyCallback(rawBody, signature)) {
    await audit.record(systemCtx(p.business_id, env), 'payment.bad_signature', { entityType: 'appointment', entityId: p.appointment_id, newValues: { payment: p.id, via: 'callback' } });
    return { ok: false, status: 401 };
  }
  let body = null;
  try { body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); } catch { body = null; }
  if (!body || String(body.tran_ref || '') !== String(p.provider_ref)) return { ok: false, status: 400 };
  return { ok: true, result: await verify(p, env) };
}

/** PayTabs return (the patient's browser posts back): signature check, then the same server-side verification. */
async function paytabsReturn(publicId, fields, env = {}) {
  const p = await byPublicId(publicId);
  if (!p || p.provider !== 'paytabs') return { payment: null, result: 'unknown' };
  const gw = await gateway(p.business_id);
  const client = clientOf(gw, p.currency);
  if (!client) return { payment: p, result: 'unknown' };
  if (fields && fields.signature && !client.verifyReturn(fields)) {
    await audit.record(systemCtx(p.business_id, env), 'payment.bad_signature', { entityType: 'appointment', entityId: p.appointment_id, newValues: { payment: p.id, via: 'return' } });
    return { payment: p, result: 'failed' };
  }
  try { return { payment: p, result: await verify(p, env) }; } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { payment: p, result: 'pending' };
  }
}

/** HyperPay return (?id=<checkout id>): the id must be this payment's checkout, then it is verified with HyperPay. */
async function hyperpayReturn(publicId, checkoutId, env = {}) {
  const p = await byPublicId(publicId);
  if (!p || p.provider !== 'hyperpay') return { payment: null, result: 'unknown' };
  if (!checkoutId || String(checkoutId) !== String(p.provider_ref)) return { payment: p, result: 'failed' };
  try { return { payment: p, result: await verify(p, env) }; } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { payment: p, result: 'pending' };
  }
}

// ---------------------------------------------------------------- refunds
async function get(ctx, id) {
  const p = await knex('payments as p').join('appointments as a', 'a.id', 'p.appointment_id').where({ 'p.id': id, 'p.business_id': ctx.businessId })
    .modify((q) => { if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId); })
    .first('p.*', 'a.patient_name', 'a.patient_phone', 'a.appointment_date', 'a.appointment_time', 'a.status as appointment_status', 'a.payment_status');
  if (!p) throw E.notFound('Payment');
  return p;
}

/** Full refund through the provider; voids the invoice when this payment made it (visit back to unpaid). */
async function refund(ctx, id) {
  const p = await get(ctx, id);
  if (p.status !== 'paid') throw new AppError('PAY_NOT_REFUNDABLE', 'Only a paid payment can be refunded.', 409);
  const gw = await gateway(ctx.businessId);
  if (gw.provider !== p.provider) throw new AppError('PAY_NOT_CONFIGURED', 'The payment gateway changed.', 409);
  const client = clientOf(gw, p.currency);
  if (!client) throw new AppError('PAY_NOT_CONFIGURED', 'The payment gateway is not set up.', 409);
  // Claim the refund first so two clicks cannot refund twice.
  const claimed = await knex('payments').where({ id: p.id, status: 'paid' }).whereNull('refund_ref').update({ refund_ref: 'pending', updated_at: new Date() });
  if (!claimed) throw new AppError('PAY_NOT_REFUNDABLE', 'This payment is already being refunded.', 409);
  let r;
  try {
    r = p.provider === 'paytabs'
      ? await client.refund({ tranRef: p.provider_payment_id || p.provider_ref, cartId: p.cart_id, amount: Number(p.amount), currency: p.currency, reason: `Refund #${p.appointment_id}` })
      : await client.refund({ paymentId: p.provider_payment_id, amount: Number(p.amount), currency: p.currency, brand: p.brand || 'card' });
  } catch (e) {
    await knex('payments').where({ id: p.id }).update({ refund_ref: null });
    throw e;
  }
  if (!r.ok) {
    await knex('payments').where({ id: p.id }).update({ refund_ref: null });
    await audit.record(ctx, 'payment.refund_failed', { entityType: 'appointment', entityId: p.appointment_id, newValues: { payment: p.id, code: r.code, message: r.message } });
    throw new AppError('PAY_REFUND_FAILED', r.message || 'The provider refused the refund.', 422);
  }
  await knex('payments').where({ id: p.id }).update({
    status: 'refunded', refunded_amount: Number(p.amount), refund_ref: String(r.ref || '').slice(0, 120) || 'ok', refunded_at: new Date(), refunded_by: ctx.userId || null, updated_at: new Date(),
  });
  let voided = false;
  if (p.invoice_id) {
    const inv = await knex('invoices').where({ id: p.invoice_id, business_id: ctx.businessId }).first('id');
    if (inv) { await appts.voidInvoice(ctx, inv.id); voided = true; }
  }
  await audit.record(ctx, 'payment.refunded', { entityType: 'appointment', entityId: p.appointment_id, newValues: { payment: p.id, amount: Number(p.amount), currency: p.currency, refund_ref: r.ref, invoice_voided: voided } });
  return { voided };
}

// ---------------------------------------------------------------- holds & reconciliation (interval job)
/**
 * Releases online consultations that waited for payment longer than the clinic's hold time: they are cancelled
 * (the patient is told by e-mail when mail is set up) and the time becomes free again. A booking whose payment
 * page was opened recently is kept a little longer, and unfinished payments are first re-checked with the provider.
 */
async function expireHolds(now = Date.now(), env = {}) {
  const gws = await knex('payment_gateways').whereNot('provider', 'none').where('hold_minutes', '>', 0).select('business_id', 'hold_minutes');
  let released = 0;
  for (const g of gws) {
    const cutoff = new Date(now - Number(g.hold_minutes) * 60_000);
    const rows = await knex('appointments as a').join('online_consultations as oc', 'oc.appointment_id', 'a.id') // eslint-disable-line no-await-in-loop
      .where({ 'a.business_id': g.business_id, 'a.appointment_type': 'online', 'a.status': 'pending', 'a.payment_status': 'unpaid', 'oc.payment_required': true })
      .where('a.amount_due', '>', 0).where('a.created_at', '<', cutoff).select('a.id', 'a.status', 'a.appointment_type', 'a.created_at');
    for (const a of rows) {
      const open = await knex('payments').where({ business_id: g.business_id, appointment_id: a.id, status: 'initiated' }).orderBy('id', 'desc').first(); // eslint-disable-line no-await-in-loop
      if (open) {
        try { if (await verify(open, env) === 'paid') continue; } catch { /* provider unreachable: decide by age */ } // eslint-disable-line no-await-in-loop, no-continue
        if (new Date(open.created_at).getTime() > now - PAGE_LIFETIME_MIN * 60_000) continue; // eslint-disable-line no-continue
      }
      const fresh = await knex('appointments').where({ id: a.id }).first('status', 'payment_status'); // eslint-disable-line no-await-in-loop
      if (!fresh || fresh.status !== 'pending' || fresh.payment_status !== 'unpaid') continue; // eslint-disable-line no-continue
      const clinic = await knex('businesses').where({ id: g.business_id }).first('timezone'); // eslint-disable-line no-await-in-loop
      const ctx = systemCtx(g.business_id, { ...env, timezone: clinic && clinic.timezone });
      await appts.setStatus(ctx, a.id, 'cancelled'); // eslint-disable-line no-await-in-loop
      await knex('payments').where({ business_id: g.business_id, appointment_id: a.id, status: 'initiated' }).update({ status: 'cancelled', updated_at: new Date() }); // eslint-disable-line no-await-in-loop
      await audit.record(ctx, 'payment.hold_expired', { entityType: 'appointment', entityId: a.id, newValues: { hold_minutes: Number(g.hold_minutes) } }); // eslint-disable-line no-await-in-loop
      released += 1;
    }
  }
  return released;
}

/** Paid payments whose invoice step did not finish (crash between the two) are settled again. */
async function reconcile(env = {}) {
  const stuck = await knex('payments').where({ status: 'paid' }).whereNull('invoice_id')
    .where((q) => q.whereNull('note').orWhere((q2) => q2.where('note', 'settling').where('updated_at', '<', new Date(Date.now() - 10 * 60_000))))
    .limit(50).select('id', 'note');
  for (const s of stuck) {
    if (s.note === 'settling') await knex('payments').where({ id: s.id, note: 'settling' }).update({ note: null }); // eslint-disable-line no-await-in-loop
    try { await settle(s.id, env); } catch (e) { console.error('[payments] settle failed:', e.message); } // eslint-disable-line no-console, no-await-in-loop
  }
  return stuck.length;
}

async function runDue(now = Date.now()) {
  await reconcile();
  return expireHolds(now);
}

// ---------------------------------------------------------------- staff lists
async function list(ctx, { status, page = 1 } = {}) {
  const q = knex('payments as p').join('appointments as a', 'a.id', 'p.appointment_id').where('p.business_id', ctx.businessId);
  if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId);
  if (STATUSES.includes(status)) q.where('p.status', status);
  if (status === 'attention') q.whereIn('p.note', ['duplicate', 'late', 'mismatch']).whereNot('p.status', 'refunded');
  const per = 50;
  const [{ n }] = await q.clone().count({ n: '*' });
  const rows = await q.orderBy('p.id', 'desc').limit(per).offset((Math.max(1, Number(page) || 1) - 1) * per)
    .select('p.*', 'a.patient_name', 'a.appointment_date', 'a.appointment_time', 'a.status as appointment_status');
  return { rows, total: Number(n), page: Math.max(1, Number(page) || 1), pages: Math.max(1, Math.ceil(Number(n) / per)) };
}

module.exports = {
  PROVIDERS, MODES, REGIONS, STATUSES, DEFAULT_HOLD_MIN, PAGE_LIFETIME_MIN, PUBLIC_ID_RE,
  gateway, gatewayView, saveGateway, testGateway, clientOf, onlineOption, lastPayment, paymentsOf, byPublicId,
  start, applyResult, settle, verify, paytabsCallback, paytabsReturn, hyperpayReturn, get, refund, expireHolds, reconcile, runDue, list, systemCtx,
};
