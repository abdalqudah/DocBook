// ============================================================================
// Appointment messages: booking confirmation, reminders (24 h and 2 h before by default) and review requests,
// sent through WhatsApp Cloud API templates, a generic HTTP SMS provider (fallback) and e-mail.
//   • per clinic settings in clinic_messaging (credentials encrypted with src/core/secrets)
//   • the patient's secret links: /r/<token> (confirm / cancel / reschedule / calendar) and /review/<token>
//   • interval job (runDue) started from src/server.js: selects what is due in each clinic's time zone, claims
//     it with a unique key in message_dispatches (INSERT IGNORE — safe with several processes), sends, logs
//   • opt-out: patients.messaging_opt_out is respected by every automated message
//   • messages carry only the clinic name, doctor name, date/time and links — never clinical information
// ============================================================================
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const mailer = require('../../core/mailer');
const { randomToken, sha256, safeEqual } = require('../../core/tokens');
const { translator } = require('../../core/i18n');
const { z, validate, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const businesses = require('../businesses/business.service');
const notifications = require('../notifications/notification.service');
const scheduling = require('../clinic/scheduling');
const appts = require('../clinic/appointments.service');
const options = require('../settings/options');
const countries = require('../telehealth/countries');
const ch = require('./channels');

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const REVIEW_LINK_DAYS = 30;
const LOG_LIMIT = 200;
const STOP_WORDS = ['stop', 'unsubscribe', 'stop all', 'cancel messages', 'إيقاف', 'ايقاف', 'توقف', 'الغاء الاشتراك', 'إلغاء الاشتراك', 'الغاء', 'إلغاء'];
const START_WORDS = ['start', 'subscribe', 'اشتراك', 'تفعيل'];
const ACTIVE = ['pending', 'confirmed'];
const DEFAULTS = {
  confirmations_enabled: true, reminders_enabled: true, reminder_offsets: [1440, 120], reviews_enabled: true, review_delay_minutes: 120,
  use_whatsapp: true, use_sms: false, use_email: true, message_locale: 'ar', default_dial: null,
  wa_phone_number_id: null, wa_token_enc: null, wa_tpl_confirmation: null, wa_tpl_reminder: null, wa_tpl_review: null,
  wa_lang_ar: 'ar', wa_lang_en: 'en', wa_quick_confirm: false, wa_hook_key: null, wa_app_secret_enc: null, wa_verify_token: null, wa_verified_at: null, wa_last_error: null,
  sms_url: null, sms_method: 'POST', sms_content_type: 'application/json', sms_body_template: null, sms_auth_header: null, sms_auth_enc: null, sms_inbound_key: null,
  cancel_cutoff_hours: 3, allow_reschedule: true,
};

// ---------------------------------------------------------------- time
/** UTC milliseconds of a clinic wall-clock date + time. */
function zonedToUtc(date, time, tz) {
  const [y, mo, d] = String(date).split('-').map(Number);
  const [h, mi] = String(time).split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (at) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - at;
  };
  let utc = guess - offset(guess);
  utc = guess - offset(utc);
  return utc;
}
const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lengthOf = (a) => Number(a.duration_minutes || a.service_duration || a.slot_duration_minutes || 30);
const startOf = (a, tz) => zonedToUtc(a.appointment_date, a.appointment_time, tz);

/** "الأحد 5 تشرين الأول" / "Sunday 5 October" (Latin digits, clinic calendar date). */
function dateText(date, locale) {
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ar-u-nu-latn', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00Z`));
  } catch { return date; }
}

// ---------------------------------------------------------------- settings
const parseOffsets = (v) => {
  let list = v;
  if (typeof v === 'string') { try { list = JSON.parse(v); } catch { list = null; } }
  if (!Array.isArray(list)) return DEFAULTS.reminder_offsets.slice();
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n >= 15 && n <= 7 * 1440))].sort((a, b) => b - a).slice(0, 3);
};

async function getConfig(businessId) {
  const row = await knex('clinic_messaging').where({ business_id: businessId }).first();
  const cfg = { ...DEFAULTS, ...(row || {}), business_id: businessId, saved: Boolean(row) };
  for (const k of ['confirmations_enabled', 'reminders_enabled', 'reviews_enabled', 'use_whatsapp', 'use_sms', 'use_email', 'wa_quick_confirm', 'allow_reschedule']) cfg[k] = Boolean(cfg[k]);
  cfg.reminder_offsets = parseOffsets(cfg.reminder_offsets);
  return cfg;
}

const waCreds = (cfg) => {
  if (!cfg.wa_phone_number_id || !cfg.wa_token_enc) return null;
  const token = secrets.decrypt(cfg.wa_token_enc);
  return token ? { phoneNumberId: cfg.wa_phone_number_id, token } : null;
};
const smsCfg = (cfg) => (cfg.sms_url && (cfg.sms_body_template || cfg.sms_method === 'GET') ? {
  url: cfg.sms_url, method: cfg.sms_method, contentType: cfg.sms_content_type, bodyTemplate: cfg.sms_body_template,
  authHeader: cfg.sms_auth_header, authValue: cfg.sms_auth_enc ? secrets.decrypt(cfg.sms_auth_enc) : null,
} : null);

/** Which channels can really send for this clinic now. */
function readiness(cfg) {
  const whatsapp = Boolean(cfg.use_whatsapp && waCreds(cfg));
  const sms = Boolean(cfg.use_sms && smsCfg(cfg));
  const email = Boolean(cfg.use_email && mailer.configured());
  return { whatsapp, sms, email, any: whatsapp || sms || email, waConfigured: Boolean(waCreds(cfg)), smsConfigured: Boolean(smsCfg(cfg)), mailConfigured: mailer.configured() };
}

const dialFor = (cfg, clinic) => cfg.default_dial || countries.dialOf(clinic.country) || countries.dialOf(options.countryForZone(clinic.timezone)) || null;

const bool = () => z.preprocess((v) => v === '1' || v === 'on' || v === true || v === 'true', z.boolean());
const int = (min, max) => z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a whole number.').min(min, `Must be at least ${min}.`).max(max, `Must be at most ${max}.`).optional());
const opt = (max) => z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());
const tplName = () => z.preprocess(emptyToUndefined, z.string().trim().max(120).regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores.').optional());
const langCode = () => z.preprocess(emptyToUndefined, z.string().trim().max(10).regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Choose a valid value.').optional());

const settingsSchema = z.object({
  confirmations_enabled: bool(), reminders_enabled: bool(), reviews_enabled: bool(), use_whatsapp: bool(), use_sms: bool(), use_email: bool(), wa_quick_confirm: bool(), allow_reschedule: bool(),
  reminder_1: z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).min(0.25, 'Must be at least 0.25.').max(168, 'Must be at most 168.').optional()),
  reminder_2: z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).min(0.25, 'Must be at least 0.25.').max(168, 'Must be at most 168.').optional()),
  review_delay_minutes: int(0, 7 * 1440), cancel_cutoff_hours: int(0, 72),
  message_locale: z.enum(['ar', 'en'], { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  default_dial: z.preprocess(emptyToUndefined, z.string().trim().regex(/^\+?\d{1,4}$/, 'Choose a valid value.').optional()),
  wa_phone_number_id: z.preprocess(emptyToUndefined, z.string().trim().regex(/^\d{5,30}$/, 'Enter a valid value.').optional()),
  wa_token: opt(1000), wa_app_secret: opt(200), wa_verify_token: opt(64),
  wa_tpl_confirmation: tplName(), wa_tpl_reminder: tplName(), wa_tpl_review: tplName(), wa_lang_ar: langCode(), wa_lang_en: langCode(),
  sms_url: z.preprocess(emptyToUndefined, z.string().trim().max(500).url('Enter a valid URL.').refine((v) => /^https?:\/\//i.test(v), 'Enter a valid URL.').optional()),
  sms_method: z.enum(['POST', 'GET']).default('POST'),
  sms_content_type: z.enum(['application/json', 'application/x-www-form-urlencoded']).default('application/json'),
  sms_body_template: opt(2000), sms_auth_header: z.preprocess(emptyToUndefined, z.string().trim().max(60).regex(/^[A-Za-z0-9-]+$/, 'Enter a valid value.').optional()), sms_auth: opt(1000),
  clear_wa_token: bool(), clear_sms_auth: bool(),
});

async function saveSettings(ctx, input) {
  const d = validate(settingsSchema, input);
  const before = await getConfig(ctx.businessId);
  const offsets = parseOffsets([d.reminder_1, d.reminder_2].filter((v) => v !== undefined).map((h) => Math.round(h * 60)));
  const row = {
    confirmations_enabled: d.confirmations_enabled, reminders_enabled: d.reminders_enabled, reviews_enabled: d.reviews_enabled,
    use_whatsapp: d.use_whatsapp, use_sms: d.use_sms, use_email: d.use_email, wa_quick_confirm: d.wa_quick_confirm, allow_reschedule: d.allow_reschedule,
    reminder_offsets: JSON.stringify(offsets), review_delay_minutes: d.review_delay_minutes ?? DEFAULTS.review_delay_minutes, cancel_cutoff_hours: d.cancel_cutoff_hours ?? DEFAULTS.cancel_cutoff_hours,
    message_locale: d.message_locale, default_dial: d.default_dial ? d.default_dial.replace(/\D/g, '') : null,
    wa_phone_number_id: d.wa_phone_number_id || null, wa_tpl_confirmation: d.wa_tpl_confirmation || null, wa_tpl_reminder: d.wa_tpl_reminder || null, wa_tpl_review: d.wa_tpl_review || null,
    wa_lang_ar: d.wa_lang_ar || 'ar', wa_lang_en: d.wa_lang_en || 'en', wa_verify_token: d.wa_verify_token || before.wa_verify_token || randomToken(18),
    sms_url: d.sms_url || null, sms_method: d.sms_method, sms_content_type: d.sms_content_type, sms_body_template: d.sms_body_template || null, sms_auth_header: d.sms_auth_header || null,
    wa_hook_key: before.wa_hook_key || randomToken(32), sms_inbound_key: before.sms_inbound_key || randomToken(32),
    updated_by: ctx.userId, updated_at: new Date(),
  };
  // Secrets: an empty field keeps the stored value; "remove" clears it.
  const enc = (v) => {
    try { return secrets.encrypt(v); } catch { throw new AppError('MESSAGING_NO_APP_KEY', 'Set APP_KEY on the server before saving credentials.', 422); }
  };
  if (d.wa_token) row.wa_token_enc = enc(d.wa_token); else if (d.clear_wa_token) row.wa_token_enc = null;
  if (d.wa_app_secret) row.wa_app_secret_enc = enc(d.wa_app_secret);
  if (d.sms_auth) row.sms_auth_enc = enc(d.sms_auth); else if (d.clear_sms_auth) row.sms_auth_enc = null;
  if (row.wa_phone_number_id !== before.wa_phone_number_id || d.wa_token) row.wa_last_error = null;
  await knex('clinic_messaging').insert({ business_id: ctx.businessId, ...row, created_at: new Date() }).onConflict('business_id').merge(row);
  const shown = { ...row };
  for (const k of ['wa_token_enc', 'wa_app_secret_enc', 'sms_auth_enc', 'wa_verify_token', 'wa_hook_key', 'sms_inbound_key']) delete shown[k];
  await audit.record(ctx, 'messaging.settings_updated', { entityType: 'clinic_messaging', entityId: ctx.businessId, newValues: { ...shown, wa_token: d.wa_token ? '[set]' : undefined, sms_auth: d.sms_auth ? '[set]' : undefined } });
}

// ---------------------------------------------------------------- patient links
// Link tokens are kept encrypted with a key derived from APP_KEY (or the session secret) so the next message can
// repeat the same link; look-ups use the SHA-256. If the secret changes, a new link is issued on the next send.
let linkKey;
const keyOf = () => {
  if (!linkKey) linkKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(process.env.APP_KEY || config.sessionSecret), Buffer.from('engage'), Buffer.from('patient-link-v1'), 32));
  return linkKey;
};
const sealToken = (value) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(), iv);
  const data = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
};
const openToken = (payload) => {
  try {
    const [v, iv, tag, data] = String(payload || '').split(':');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', keyOf(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
};
const newToken = () => { const token = randomToken(32); return { token, token_hash: sha256(token), token_enc: sealToken(token) }; };

/** The patient's link for an appointment (created on first use; the same token is reused by every message). */
async function linkFor(appt, purpose, now = Date.now()) {
  if (!['action', 'review'].includes(purpose)) throw new Error('bad purpose');
  let row = await knex('appointment_links').where({ appointment_id: appt.id, purpose }).first();
  if (!row) {
    const t = newToken();
    await knex('appointment_links').insert({
      business_id: appt.business_id, appointment_id: appt.id, purpose, token_hash: t.token_hash, token_enc: t.token_enc,
      expires_at: purpose === 'review' ? new Date(now + REVIEW_LINK_DAYS * 86_400_000) : null,
    }).onConflict(['appointment_id', 'purpose']).ignore();
    row = await knex('appointment_links').where({ appointment_id: appt.id, purpose }).first();
  }
  let token = openToken(row.token_enc);
  if (!token || sha256(token) !== row.token_hash) { // APP_KEY changed: issue a new link
    const t = newToken();
    await knex('appointment_links').where({ id: row.id }).update({ token_hash: t.token_hash, token_enc: t.token_enc });
    token = t.token;
  }
  return { token, row };
}

const LINK_SELECT = ['l.id as link_id', 'l.purpose', 'l.expires_at', 'l.used_at', 'l.token_hash', 'a.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en',
  'd.specialization as doctor_spec', 'd.specialization_en as doctor_spec_en', 'd.slot_duration_minutes', 's.duration_minutes as service_duration', 's.name as service_name', 's.name_en as service_name_en'];

/** The appointment behind a link token (null when malformed, unknown or of another purpose). */
async function byToken(token, purpose) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const row = await knex('appointment_links as l').join('appointments as a', 'a.id', 'l.appointment_id')
    .leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
    .where({ 'l.token_hash': sha256(String(token)), 'l.purpose': purpose }).first(LINK_SELECT);
  if (!row || !safeEqual(row.token_hash, sha256(String(token)))) return null;
  return row;
}

const baseOf = (base) => String(base || config.appUrl).replace(/\/+$/, '');
const actionUrl = (base, token) => `${baseOf(base)}/r/${token}`;
const reviewUrl = (base, token) => `${baseOf(base)}/review/${token}`;

/**
 * State of an action link:
 *  expired     — the appointment is over (the link no longer works)
 *  open        — pending/confirmed and not started yet
 *  locked      — within the clinic's cut-off: no cancel / reschedule online (confirm is still allowed)
 */
function actionState(a, clinic, cfg, now = Date.now()) {
  const startMs = startOf(a, clinic.timezone);
  const endMs = startMs + lengthOf(a) * 60_000;
  const expired = a.appointment_type === 'blocked' || now >= endMs;
  const open = !expired && ACTIVE.includes(a.status) && now < startMs;
  const locked = open && startMs - now < Number(cfg.cancel_cutoff_hours || 0) * 3_600_000;
  return {
    startMs, endMs, expired, open, locked,
    canConfirm: open && a.status === 'pending',
    canCancel: open && !locked && a.payment_status !== 'paid',
    canReschedule: open && !locked && cfg.allow_reschedule && Boolean(a.doctor_id) && a.appointment_type === 'in_person' && a.payment_status !== 'paid',
  };
}

// ---------------------------------------------------------------- opt-out
async function patientsForPhone(businessId, phone, dial) {
  const target = ch.msisdn(phone, dial);
  if (!target) return [];
  const tail = target.slice(-8);
  const rows = await knex('patients').where({ business_id: businessId }).where('phone', 'like', `%${tail.slice(0, 2)}%${tail.slice(2, 5)}%${tail.slice(5)}%`).select('id', 'phone', 'messaging_opt_out');
  return rows.filter((p) => ch.msisdn(p.phone, dial) === target);
}

async function isOptedOut(appt, dial) {
  if (appt.patient_id) {
    const p = await knex('patients').where({ id: appt.patient_id, business_id: appt.business_id }).first('messaging_opt_out');
    if (p && p.messaging_opt_out) return true;
  }
  if (appt.patient_phone) return (await patientsForPhone(appt.business_id, appt.patient_phone, dial)).some((p) => p.messaging_opt_out);
  return false;
}

/** Opts a patient out (or back in) of automated messages — by patient id and every record with the same number. */
async function setOptOut(businessId, { patientId, phone, dial }, out = true, meta = {}) {
  const ids = new Set();
  if (patientId) ids.add(Number(patientId));
  if (phone) (await patientsForPhone(businessId, phone, dial)).forEach((p) => ids.add(p.id));
  if (!ids.size) return 0;
  const n = await knex('patients').where({ business_id: businessId }).whereIn('id', [...ids])
    .update({ messaging_opt_out: out, messaging_opt_out_at: out ? new Date() : null, updated_at: new Date() });
  await audit.record({ businessId, userId: meta.userId || null, ip: meta.ip, userAgent: meta.userAgent }, out ? 'messaging.opted_out' : 'messaging.opted_in',
    { entityType: 'patient', entityId: [...ids].join(','), newValues: { via: meta.via || 'link' } });
  await log({ business_id: businessId, stage: out ? 'opt_out' : 'opt_in', channel: meta.channel || 'link', recipient: phone ? ch.maskPhone(ch.msisdn(phone, dial)) : null, status: 'received', user_id: meta.userId || null });
  return n;
}

// ---------------------------------------------------------------- log
async function log(entry) {
  const [id] = await knex('message_log').insert({
    business_id: entry.business_id, appointment_id: entry.appointment_id || null, dispatch_id: entry.dispatch_id || null, stage: entry.stage, channel: entry.channel,
    recipient: entry.recipient || null, status: entry.status, provider_id: entry.provider_id || null, error: entry.error ? String(entry.error).slice(0, 255) : null, user_id: entry.user_id || null,
  });
  return id;
}

async function recentLog(businessId, limit = LOG_LIMIT) {
  return knex('message_log as m').leftJoin('appointments as a', function j() { this.on('a.id', 'm.appointment_id').andOn('a.business_id', 'm.business_id'); })
    .where('m.business_id', businessId).orderBy('m.id', 'desc').limit(limit)
    .select('m.id', 'm.appointment_id', 'm.stage', 'm.channel', 'm.recipient', 'm.status', 'm.error', 'm.created_at', 'a.appointment_date', 'a.appointment_time');
}

async function logSummary(businessId, days = 30) {
  const rows = await knex('message_log').where({ business_id: businessId }).where('created_at', '>=', new Date(Date.now() - days * 86_400_000))
    .groupBy('status').select('status').count({ n: '*' });
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

// ---------------------------------------------------------------- composing
const KIND = (stage) => (stage === 'confirmation' ? 'confirmation' : stage === 'review' ? 'review' : 'reminder');

function messageVars(a, clinic, locale) {
  const en = locale === 'en';
  return {
    clinic: (en && clinic.name_en) || clinic.name,
    doctor: (en && a.doctor_name_en) || a.doctor_name || (en ? 'the clinic' : 'العيادة'),
    date: dateText(a.appointment_date, locale),
    time: a.appointment_time,
  };
}

/** Plain text for SMS, e-mail and click-to-chat. */
function composeText(kind, vars, link, locale, { stop = true } = {}) {
  const t = translator(locale);
  const body = t(`messaging.text.${kind}`, { ...vars, link });
  return stop ? `${body}\n${t('messaging.text.stop_hint')}` : body;
}

// ---------------------------------------------------------------- sending one stage
const APPT_SELECT = ['a.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.slot_duration_minutes', 's.duration_minutes as service_duration'];
const apptQuery = () => knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id');

async function claim(a, stage, slotKey, status = 'claimed') {
  const [id] = await knex('message_dispatches').insert({ business_id: a.business_id, appointment_id: a.id, stage, slot_key: slotKey, status, claimed_at: new Date(), finished_at: status === 'claimed' ? null : new Date() })
    .onConflict(['appointment_id', 'stage', 'slot_key']).ignore();
  return Number(id) || null; // 0 / undefined when another run already has it
}
const slotKeyOf = (a, stage) => (stage === 'review' ? 'visit' : `${a.appointment_date} ${a.appointment_time}`);

/**
 * Sends one stage (confirmation | reminder_<m> | review) of one appointment through the clinic's channels:
 * WhatsApp first, SMS when WhatsApp is not set up or fails, and e-mail when the patient has an address.
 * Returns the dispatch status, or null when another process already claimed it.
 */
async function sendStage(clinic, cfg, a, stage, { base, now = Date.now() } = {}) {
  const dispatchId = await claim(a, stage, slotKeyOf(a, stage));
  if (!dispatchId) return null;
  const finish = async (status) => { await knex('message_dispatches').where({ id: dispatchId }).update({ status, finished_at: new Date() }); return status; };
  const dial = dialFor(cfg, clinic);
  const to = ch.msisdn(a.patient_phone, dial);
  if (await isOptedOut(a, dial)) {
    await log({ business_id: a.business_id, appointment_id: a.id, dispatch_id: dispatchId, stage, channel: 'link', recipient: to ? ch.maskPhone(to) : null, status: 'opted_out' });
    return finish('opted_out');
  }
  const kind = KIND(stage);
  const locale = cfg.message_locale === 'en' ? 'en' : 'ar';
  const { token } = await linkFor(a, kind === 'review' ? 'review' : 'action', now);
  const link = kind === 'review' ? reviewUrl(base, token) : actionUrl(base, token);
  const vars = messageVars(a, clinic, locale);
  const ready = readiness(cfg);
  const results = [];
  let phoneDone = false;
  const tpl = { confirmation: cfg.wa_tpl_confirmation, reminder: cfg.wa_tpl_reminder, review: cfg.wa_tpl_review }[kind];
  if (to && ready.whatsapp && tpl) {
    const payload = ch.waTemplatePayload({
      to, template: tpl, language: locale === 'en' ? cfg.wa_lang_en : cfg.wa_lang_ar,
      body: kind === 'review' ? [vars.clinic, vars.doctor] : [vars.clinic, vars.doctor, vars.date, vars.time],
      urlSuffix: token, quickPayload: kind === 'reminder' && cfg.wa_quick_confirm ? `confirm:${token}` : undefined,
    });
    const r = await ch.sendWhatsApp(waCreds(cfg), payload);
    results.push(r.ok);
    phoneDone = r.ok;
    await log({ business_id: a.business_id, appointment_id: a.id, dispatch_id: dispatchId, stage, channel: 'whatsapp', recipient: ch.maskPhone(to), status: r.ok ? 'sent' : 'failed', provider_id: r.id, error: r.error });
    if (!r.ok) await knex('clinic_messaging').where({ business_id: a.business_id }).update({ wa_last_error: String(r.error || '').slice(0, 255) });
  }
  if (to && !phoneDone && ready.sms) {
    const r = await ch.sendSms(smsCfg(cfg), to, composeText(kind, vars, link, locale));
    results.push(r.ok);
    await log({ business_id: a.business_id, appointment_id: a.id, dispatch_id: dispatchId, stage, channel: 'sms', recipient: ch.maskPhone(to), status: r.ok ? 'sent' : 'failed', provider_id: r.id, error: r.error });
  }
  if (a.patient_email && ready.email) {
    const t = translator(locale);
    const subject = t(`messaging.mail.${kind}_subject`, vars);
    const html = mailer.layout({ locale, title: subject, body: t(`messaging.mail.${kind}_body`, vars), cta: t(`messaging.mail.${kind}_cta`), href: link });
    const r = await ch.sendEmail({ to: a.patient_email, subject, html, replyTo: clinic.email || undefined });
    results.push(r.ok);
    await log({ business_id: a.business_id, appointment_id: a.id, dispatch_id: dispatchId, stage, channel: 'email', recipient: ch.maskEmail(a.patient_email), status: r.ok ? 'sent' : 'failed', error: r.error });
  }
  if (!results.length) return finish('skipped');
  return finish(results.some(Boolean) ? 'sent' : 'failed');
}

// ---------------------------------------------------------------- selection (pure — unit tested)
/**
 * Which reminder stage (if any) is due for an appointment now.
 * Only the latest due stage is sent (a missed 24 h reminder is skipped when the 2 h one is due), nothing after the
 * start, and nothing whose due time was before the booking was made (the booking confirmation covers it).
 * @returns {{ send: string|null, skip: string[] }}
 */
function dueReminder({ startMs, createdMs, offsets, now }) {
  if (now >= startMs) return { send: null, skip: [] };
  const due = offsets.filter((m) => now >= startMs - m * 60_000 && createdMs < startMs - m * 60_000).sort((x, y) => x - y);
  if (!due.length) return { send: null, skip: [] };
  return { send: `reminder_${due[0]}`, skip: due.slice(1).map((m) => `reminder_${m}`) };
}

// ---------------------------------------------------------------- the interval job
async function clinicsToServe() {
  const rows = await knex('clinic_messaging as m').join('businesses as b', 'b.id', 'm.business_id').where('b.status', 'active').select('m.business_id');
  const out = [];
  for (const r of rows) {
    const cfg = await getConfig(r.business_id); // eslint-disable-line no-await-in-loop
    if (readiness(cfg).any) out.push(cfg);
  }
  return out;
}

async function runClinic(cfg, now, base) {
  const clinic = await businesses.get(cfg.business_id);
  if (!clinic || clinic.status !== 'active') return { sent: 0 };
  const tz = clinic.timezone || 'UTC';
  const today = scheduling.clinicNow(tz, new Date(now)).date;
  let sent = 0;
  const done = (s) => { if (s === 'sent') sent += 1; };
  // 1. Booking confirmations (appointments made in the last 6 hours that have not started).
  if (cfg.confirmations_enabled) {
    const rows = await apptQuery().where('a.business_id', clinic.id).whereIn('a.status', ACTIVE).whereNot('a.appointment_type', 'blocked')
      .where('a.created_at', '>=', new Date(now - 6 * 3_600_000)).where('a.appointment_date', '>=', today).limit(200).select(APPT_SELECT);
    for (const a of rows) {
      if (startOf(a, tz) <= now) continue; // eslint-disable-line no-continue
      done(await sendStage(clinic, cfg, a, 'confirmation', { base, now })); // eslint-disable-line no-await-in-loop
    }
  }
  // 2. Reminders, in the clinic's time zone.
  if (cfg.reminders_enabled && cfg.reminder_offsets.length) {
    const horizon = addDays(today, Math.ceil(Math.max(...cfg.reminder_offsets) / 1440) + 1);
    const rows = await apptQuery().where('a.business_id', clinic.id).whereIn('a.status', ACTIVE).whereNot('a.appointment_type', 'blocked')
      .whereBetween('a.appointment_date', [today, horizon]).limit(1000).select(APPT_SELECT);
    for (const a of rows) {
      const pick = dueReminder({ startMs: startOf(a, tz), createdMs: new Date(a.created_at).getTime(), offsets: cfg.reminder_offsets, now });
      if (!pick.send) continue; // eslint-disable-line no-continue
      for (const s of pick.skip) await claim(a, s, slotKeyOf(a, s), 'skipped'); // eslint-disable-line no-await-in-loop
      done(await sendStage(clinic, cfg, a, pick.send, { base, now })); // eslint-disable-line no-await-in-loop
    }
  }
  // 3. Review requests after a visit (completed or paid), after the clinic's delay, for visits of the last 3 days.
  if (cfg.reviews_enabled) {
    const delayMs = Number(cfg.review_delay_minutes || 0) * 60_000;
    const rows = await apptQuery().where('a.business_id', clinic.id).whereNot('a.appointment_type', 'blocked').whereNotIn('a.status', ['cancelled', 'no_show'])
      .andWhere((w) => w.where('a.status', 'completed').orWhere('a.payment_status', 'paid'))
      .whereRaw('COALESCE(a.paid_at, a.updated_at) <= ?', [new Date(now - delayMs)])
      .whereRaw('COALESCE(a.paid_at, a.updated_at) >= ?', [new Date(now - delayMs - 3 * 86_400_000)])
      .whereNotExists(knex('reviews as r').whereRaw('r.appointment_id = a.id'))
      .limit(200).select(APPT_SELECT);
    for (const a of rows) done(await sendStage(clinic, cfg, a, 'review', { base, now })); // eslint-disable-line no-await-in-loop
  }
  return { sent };
}

let running = false;
/** Interval job (src/server.js, every minute). Safe to run in several processes: every send is claimed first. */
async function runDue(now = Date.now(), { base } = {}) {
  if (running) return 0;
  running = true;
  try {
    let sent = 0;
    for (const cfg of await clinicsToServe()) {
      try {
        sent += (await runClinic(cfg, now, base)).sent; // eslint-disable-line no-await-in-loop
      } catch (err) {
        console.error(`[messaging] clinic ${cfg.business_id}:`, err.message); // eslint-disable-line no-console
      }
    }
    return sent;
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------- staff: test send & click-to-chat
async function sendTest(ctx, phone) {
  const cfg = await getConfig(ctx.businessId);
  const clinic = await businesses.get(ctx.businessId);
  const to = ch.msisdn(phone, dialFor(cfg, clinic));
  if (!to) throw E.validation({ test_phone: 'Enter a valid phone number.' });
  const creds = waCreds(cfg);
  const locale = cfg.message_locale === 'en' ? 'en' : 'ar';
  const doctor = await knex('doctors').where({ business_id: ctx.businessId, is_active: true }).orderBy('sort_order').first('full_name', 'full_name_en');
  const tomorrow = addDays(scheduling.clinicNow(clinic.timezone).date, 1);
  const vars = messageVars({ doctor_name: doctor && doctor.full_name, doctor_name_en: doctor && doctor.full_name_en, appointment_date: tomorrow, appointment_time: '10:00' }, clinic, locale);
  let r;
  let channel;
  if (creds && cfg.wa_tpl_reminder) {
    channel = 'whatsapp';
    r = await ch.sendWhatsApp(creds, ch.waTemplatePayload({ to, template: cfg.wa_tpl_reminder, language: locale === 'en' ? cfg.wa_lang_en : cfg.wa_lang_ar,
      body: [vars.clinic, vars.doctor, vars.date, vars.time], urlSuffix: 'test', quickPayload: cfg.wa_quick_confirm ? 'test' : undefined }));
    await knex('clinic_messaging').where({ business_id: ctx.businessId }).update({ wa_last_error: r.ok ? null : String(r.error || '').slice(0, 255) });
  } else if (smsCfg(cfg)) {
    channel = 'sms';
    r = await ch.sendSms(smsCfg(cfg), to, translator(locale)('messaging.text.test', vars));
  } else {
    throw new AppError('MESSAGING_NOT_CONFIGURED', 'No WhatsApp or SMS provider is set up.', 409);
  }
  await log({ business_id: ctx.businessId, stage: 'test', channel, recipient: ch.maskPhone(to), status: r.ok ? 'sent' : 'failed', provider_id: r.id, error: r.error, user_id: ctx.userId });
  await audit.record(ctx, 'messaging.test_sent', { entityType: 'clinic_messaging', entityId: ctx.businessId, newValues: { channel, ok: r.ok } });
  return { ...r, channel };
}

/**
 * wa.me link with the ready-made message, for staff to send from their own WhatsApp (no automatic sending).
 * kind: confirmation | reminder | review (review only after a visit).
 */
async function clickToChat(ctx, apptId, kind, base) {
  const a = await appts.get(ctx, apptId);
  if (a.appointment_type === 'blocked') throw E.notFound('Appointment');
  const cfg = await getConfig(ctx.businessId);
  const clinic = await businesses.get(ctx.businessId);
  const to = ch.msisdn(a.patient_phone, dialFor(cfg, clinic));
  if (!to) throw new AppError('MESSAGING_NO_PHONE', 'This patient has no valid mobile number.', 422);
  const visited = a.status === 'completed' || a.payment_status === 'paid';
  const k = kind === 'review' && visited ? 'review' : kind === 'confirmation' ? 'confirmation' : 'reminder';
  const locale = ctx.msgLocale || (cfg.message_locale === 'en' ? 'en' : 'ar');
  const { token } = await linkFor({ ...a, business_id: ctx.businessId }, k === 'review' ? 'review' : 'action');
  const link = k === 'review' ? reviewUrl(base, token) : actionUrl(base, token);
  const text = composeText(k, messageVars(a, clinic, locale), link, locale, { stop: false });
  await log({ business_id: ctx.businessId, appointment_id: a.id, stage: 'manual', channel: 'link', recipient: ch.maskPhone(to), status: 'sent', user_id: ctx.userId });
  await audit.record(ctx, 'messaging.click_to_chat', { entityType: 'appointment', entityId: a.id, newValues: { kind: k } });
  return { href: ch.waMeLink(to, text), optedOut: await isOptedOut({ ...a, business_id: ctx.businessId }, dialFor(cfg, clinic)) };
}

// ---------------------------------------------------------------- patient actions (/r/<token> and WhatsApp buttons)
const patientCtx = (clinic, meta = {}) => ({
  businessId: clinic.id, userId: null, userName: null, timezone: clinic.timezone, locale: meta.locale || 'ar', ip: meta.ip, userAgent: meta.userAgent,
  permissions: new Set(), ownDoctorId: null, baseUrl: meta.base,
});

async function tellStaff(clinic, cfg, a, what, extra = '') {
  const t = translator(cfg.message_locale === 'en' ? 'en' : 'ar');
  await notifications.notify(clinic.id, {
    permission: 'appointments.manage', type: `appointment.patient_${what}`, severity: what === 'cancelled' ? 'warning' : 'info',
    title: t(`messaging.notify.${what}`, { name: a.patient_name, date: a.appointment_date, time: a.appointment_time }),
    body: extra ? String(extra).slice(0, 300) : null, link: `/app/appointments/${a.id}`,
  });
}

async function patientConfirm(a, clinic, cfg, meta = {}) {
  const st = actionState(a, clinic, cfg);
  if (!st.canConfirm) {
    if (st.open && a.status === 'confirmed') return 'already';
    throw new AppError('ENGAGE_CLOSED', 'This appointment can no longer be changed online.', 409);
  }
  const ctx = patientCtx(clinic, meta);
  await appts.setStatus(ctx, a.id, 'confirmed');
  await audit.record(ctx, 'engage.patient_confirmed', { entityType: 'appointment', entityId: a.id, newValues: { via: meta.via || 'link' } });
  await tellStaff(clinic, cfg, a, 'confirmed');
  return 'confirmed';
}

async function patientCancel(a, clinic, cfg, reason, meta = {}) {
  const st = actionState(a, clinic, cfg);
  if (!st.canCancel) throw new AppError(st.locked ? 'ENGAGE_CUTOFF' : 'ENGAGE_CLOSED', 'This appointment can no longer be cancelled online.', 409);
  const why = String(reason || '').trim().slice(0, 300);
  const ctx = patientCtx(clinic, meta);
  await appts.setStatus(ctx, a.id, 'cancelled');
  await audit.record(ctx, 'engage.patient_cancelled', { entityType: 'appointment', entityId: a.id, newValues: { reason: why || null, via: meta.via || 'link' } });
  await tellStaff(clinic, cfg, a, 'cancelled', why);
}

/** Free times of the same doctor (and service / length) on a date, for the patient's reschedule screen. */
async function rescheduleSlots(a, clinic, date) {
  return scheduling.availableSlots({
    businessId: clinic.id, timezone: clinic.timezone, doctorId: a.doctor_id, date, serviceId: a.service_id || undefined,
    durationOverride: a.service_id ? undefined : (a.duration_minutes || undefined), excludeAppointmentId: a.id,
  });
}

/** Moves the appointment under the slot lock (appointments.move → scheduling.withSlot). */
async function patientReschedule(a, clinic, cfg, date, time, meta = {}) {
  const st = actionState(a, clinic, cfg);
  if (!st.canReschedule) throw new AppError(st.locked ? 'ENGAGE_CUTOFF' : 'ENGAGE_CLOSED', 'This appointment can no longer be changed online.', 409);
  if (!scheduling.isDate(date) || !scheduling.isTime(time)) throw E.validation({ appointment_time: 'Choose a valid value.' });
  const ctx = patientCtx(clinic, meta);
  await appts.move(ctx, a.id, { doctor_id: a.doctor_id, appointment_date: date, appointment_time: time });
  await audit.record(ctx, 'engage.patient_rescheduled', { entityType: 'appointment', entityId: a.id,
    oldValues: { date: a.appointment_date, time: a.appointment_time }, newValues: { date, time, via: meta.via || 'link' } });
  await tellStaff(clinic, cfg, a, 'rescheduled', `${a.appointment_date} ${a.appointment_time} → ${date} ${time}`);
}

// ---------------------------------------------------------------- inbound (webhooks)
const norm = (s) => String(s || '').trim().toLowerCase().replace(/[.!؟?]+$/, '');
const isStop = (text) => STOP_WORDS.includes(norm(text));
const isStart = (text) => START_WORDS.includes(norm(text));

async function configByHook(field, key) {
  if (!TOKEN_RE.test(String(key || ''))) return null;
  const row = await knex('clinic_messaging').where(field, key).first('business_id');
  return row ? getConfig(row.business_id) : null;
}

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
function validSignature(cfg, raw, header) {
  const secret = cfg.wa_app_secret_enc ? secrets.decrypt(cfg.wa_app_secret_enc) : null;
  if (!secret || !header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return safeEqual(expected, String(header));
}

const STATUS_MAP = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };

/** WhatsApp Cloud API webhook: message statuses, STOP / START replies and the "Confirm" quick-reply button. */
async function handleWhatsApp(cfg, payload) {
  const clinic = await businesses.get(cfg.business_id);
  if (!clinic) return;
  const dial = dialFor(cfg, clinic);
  for (const entry of (payload && payload.entry) || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const s of v.statuses || []) {
        const status = STATUS_MAP[s.status];
        if (!status || !s.id) continue; // eslint-disable-line no-continue
        const err = Array.isArray(s.errors) && s.errors[0] ? `${s.errors[0].code || ''}: ${s.errors[0].title || s.errors[0].message || ''}` : null;
        await knex('message_log').where({ business_id: cfg.business_id, provider_id: String(s.id).slice(0, 120) }).whereNot('status', 'read') // eslint-disable-line no-await-in-loop
          .update({ status, ...(err ? { error: err.slice(0, 255) } : {}) });
      }
      for (const m of v.messages || []) {
        const from = String(m.from || '').replace(/\D/g, '');
        const text = (m.text && m.text.body) || (m.button && m.button.text) || (m.interactive && m.interactive.button_reply && m.interactive.button_reply.title) || '';
        const payloadText = (m.button && m.button.payload) || (m.interactive && m.interactive.button_reply && m.interactive.button_reply.id) || '';
        if (payloadText.startsWith('confirm:')) {
          const a = await byToken(payloadText.slice(8), 'action'); // eslint-disable-line no-await-in-loop
          if (a && a.business_id === cfg.business_id && ch.msisdn(a.patient_phone, dial) === from) {
            try { await patientConfirm(a, clinic, cfg, { via: 'whatsapp' }); } catch (e) { if (!(e instanceof AppError)) throw e; } // eslint-disable-line no-await-in-loop
            await log({ business_id: cfg.business_id, appointment_id: a.id, stage: 'reply', channel: 'whatsapp', recipient: ch.maskPhone(from), status: 'received' }); // eslint-disable-line no-await-in-loop
          }
        } else if (isStop(text)) {
          await setOptOut(cfg.business_id, { phone: `+${from}`, dial }, true, { via: 'whatsapp', channel: 'whatsapp' }); // eslint-disable-line no-await-in-loop
        } else if (isStart(text)) {
          await setOptOut(cfg.business_id, { phone: `+${from}`, dial }, false, { via: 'whatsapp', channel: 'whatsapp' }); // eslint-disable-line no-await-in-loop
        }
      }
    }
  }
}

/** Generic SMS inbound (provider forwards replies): STOP / START only. */
async function handleSmsReply(cfg, from, text) {
  const clinic = await businesses.get(cfg.business_id);
  if (!clinic || !from) return false;
  const dial = dialFor(cfg, clinic);
  if (isStop(text)) { await setOptOut(cfg.business_id, { phone: String(from).startsWith('+') ? from : `+${String(from).replace(/\D/g, '')}`, dial }, true, { via: 'sms', channel: 'sms' }); return true; }
  if (isStart(text)) { await setOptOut(cfg.business_id, { phone: String(from).startsWith('+') ? from : `+${String(from).replace(/\D/g, '')}`, dial }, false, { via: 'sms', channel: 'sms' }); return true; }
  return false;
}

// ---------------------------------------------------------------- calendar file
const icsDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
function ics(a, clinic, locale, link) {
  const tz = clinic.timezone || 'UTC';
  const start = startOf(a, tz);
  const end = start + lengthOf(a) * 60_000;
  const host = String(config.appUrl || 'localhost').replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  const vars = messageVars(a, clinic, locale);
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DocBook//Appointment//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:appointment-${a.id}@${host}`, `DTSTAMP:${icsDate(Date.now())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(`${vars.clinic} · ${vars.doctor}`)}`, `DESCRIPTION:${icsText(link)}`, ...(clinic.address ? [`LOCATION:${icsText(clinic.address)}`] : []),
    `URL:${link}`, `STATUS:${a.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE'}`, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

module.exports = {
  TOKEN_RE, REVIEW_LINK_DAYS, DEFAULTS, STOP_WORDS,
  zonedToUtc, dateText, lengthOf, startOf, getConfig, saveSettings, readiness, waCreds, smsCfg, dialFor,
  linkFor, byToken, actionUrl, reviewUrl, actionState, isOptedOut, setOptOut, patientsForPhone, log, recentLog, logSummary,
  messageVars, composeText, sendStage, claim, dueReminder, runClinic, runDue, sendTest, clickToChat,
  patientConfirm, patientCancel, rescheduleSlots, patientReschedule, configByHook, validSignature, handleWhatsApp, handleSmsReply, isStop, ics,
};
