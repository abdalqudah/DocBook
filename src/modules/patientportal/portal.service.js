// Patient portal: a patient of the clinic signs in on the clinic's site with the mobile or e-mail of the file and a
// password, and sees what the clinic chose to show. Accounts are made two ways: the clinic sends an activation link
// (WhatsApp from the staff member's own WhatsApp, SMS or e-mail), or the patient signs up with a one-time code sent to
// the mobile / e-mail already on the file (only when exactly one patient file has it). "Forgot password" sends a code.
// Codes and links are stored as SHA-256 only, live 10 minutes (links 3 days), allow 5 tries and are used once; the
// sign-in locks for 15 minutes after 5 wrong passwords; answers never say whether an account exists.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const config = require('../../config');

const CODE_MS = 10 * 60_000;
const LINK_MS = 72 * 3600_000;
const MAX_TRIES = 5;
const LOCK_MS = 15 * 60_000;
const DEFAULTS = { enabled: false, self_signup: true, show_visits: true, show_records: false, show_prescriptions: true, show_files: false, show_plan: true, wa_template: null };
const SECTIONS = ['show_visits', 'show_records', 'show_prescriptions', 'show_files', 'show_plan'];
let DUMMY = null;
const dummy = () => { DUMMY = DUMMY || bcrypt.hashSync('not-a-password', 10); return DUMMY; };
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const now = () => new Date();

// ================================================================= settings
async function settings(businessId) {
  const row = await knex('patient_portal_settings').where({ business_id: businessId }).first().catch(() => null);
  const s = { ...DEFAULTS, ...(row || {}) };
  ['enabled', 'self_signup', ...SECTIONS].forEach((k) => { s[k] = Boolean(s[k]); });
  return s;
}
async function saveSettings(ctx, input) {
  const before = await settings(ctx.businessId);
  const on = (k) => input[k] === '1' || input[k] === 'on' || input[k] === true;
  const row = { enabled: on('enabled'), self_signup: on('self_signup'), wa_template: String(input.wa_template || '').trim().replace(/[^a-z0-9_]/gi, '').slice(0, 120) || null, updated_by: ctx.userId || null, updated_at: now() };
  SECTIONS.forEach((k) => { row[k] = on(k); });
  await knex('patient_portal_settings').insert({ business_id: ctx.businessId, ...row }).onConflict('business_id').merge(row);
  await audit.record(ctx, 'patient_portal.settings_updated', { entityType: 'business', entityId: ctx.businessId, oldValues: before, newValues: row });
}

// ================================================================= sending a code / link
async function channelsFor(businessId) {
  const msg = require('../messaging/messaging.service'); // eslint-disable-line global-require
  const cfg = await msg.getConfig(businessId).catch(() => null);
  const s = await settings(businessId);
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  return {
    whatsapp: Boolean(cfg && msg.waCreds(cfg) && s.wa_template),
    sms: Boolean(cfg && msg.smsCfg(cfg)),
    email: Boolean(await Promise.resolve(mailer.configuredFor ? mailer.configuredFor(businessId) : mailer.configured()).catch(() => false)),
  };
}
async function dialOf(clinic) {
  const msg = require('../messaging/messaging.service'); // eslint-disable-line global-require
  const cfg = await msg.getConfig(clinic.id).catch(() => null);
  return cfg ? msg.dialFor(cfg, clinic) : '962';
}
const phoneOf = (raw, dial) => require('../messaging/channels').msisdn(raw, dial); // eslint-disable-line global-require

/** Sends `text` (and, on WhatsApp, the code as the template's parameter) to the patient by the chosen channel. */
async function deliver(clinic, channel, { phone, email }, { text, code, subject, html }) {
  const msg = require('../messaging/messaging.service'); // eslint-disable-line global-require
  const ch = require('../messaging/channels'); // eslint-disable-line global-require
  const cfg = await msg.getConfig(clinic.id);
  const s = await settings(clinic.id);
  const dial = msg.dialFor(cfg, clinic);
  if (channel === 'email') {
    if (!email) return false;
    await require('../../core/mailer').send({ to: email, subject, html: html || `<p>${text}</p>`, businessId: clinic.id }); // eslint-disable-line global-require
    return true;
  }
  const to = ch.msisdn(phone, dial);
  if (!to) return false;
  let r;
  if (channel === 'whatsapp') {
    const creds = msg.waCreds(cfg);
    if (!creds || !s.wa_template || !code) return false;
    r = await ch.sendWhatsApp(creds, ch.waTemplatePayload({ to, template: s.wa_template, language: cfg.message_locale === 'en' ? cfg.wa_lang_en : cfg.wa_lang_ar, body: [code] }));
  } else {
    const sms = msg.smsCfg(cfg);
    if (!sms) return false;
    r = await ch.sendSms(sms, to, text);
  }
  await msg.log({ business_id: clinic.id, stage: 'portal_code', channel, recipient: ch.maskPhone(to), status: r && r.ok ? 'sent' : 'failed', provider_id: r && r.id, error: r && r.error });
  return Boolean(r && r.ok);
}

async function newCode(businessId, patientId, purpose, channel) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await knex('patient_account_codes').where({ business_id: businessId, patient_id: patientId, purpose }).whereNull('used_at').update({ used_at: now() }); // one live code at a time
  await knex('patient_account_codes').insert({ business_id: businessId, patient_id: patientId, purpose, code_hash: sha(`${patientId}:${purpose}:${code}`), channel, expires_at: new Date(Date.now() + CODE_MS) });
  return code;
}

/** Checks a code for (patient, purpose); used once; 5 tries. */
async function checkCode(businessId, patientId, purpose, code) {
  const row = await knex('patient_account_codes').where({ business_id: businessId, patient_id: patientId, purpose }).whereNull('used_at').where('expires_at', '>', now()).orderBy('id', 'desc').first();
  if (!row || row.attempts >= MAX_TRIES) throw new AppError('CODE_EXPIRED', 'The code expired. Ask for a new one.', 422);
  if (row.code_hash !== sha(`${patientId}:${purpose}:${String(code || '').replace(/\D/g, '')}`)) {
    await knex('patient_account_codes').where({ id: row.id }).update({ attempts: row.attempts + 1 });
    throw new AppError('CODE_WRONG', 'The code is not right.', 422);
  }
  await knex('patient_account_codes').where({ id: row.id }).update({ used_at: now() });
  return true;
}

// ================================================================= finding the patient
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
/** The patient files that have this mobile / e-mail (for sign-up: must be exactly one). */
async function patientsWith(clinic, identifier) {
  const v = String(identifier || '').trim();
  if (isEmail(v)) return knex('patients').where({ business_id: clinic.id }).whereNull('transferred_at').whereRaw('LOWER(email) = ?', [v.toLowerCase()]).select('id', 'full_name', 'phone', 'email');
  const dial = await dialOf(clinic);
  const target = phoneOf(v, dial);
  if (!target) return [];
  const tail = target.slice(-7);
  const rows = await knex('patients').where({ business_id: clinic.id }).whereNull('transferred_at').where('phone', 'like', `%${tail}`).select('id', 'full_name', 'phone', 'email');
  return rows.filter((p) => phoneOf(p.phone, dial) === target);
}
/** The account signing in with this mobile / e-mail (null when none or more than one). */
async function accountWith(clinic, identifier) {
  const v = String(identifier || '').trim();
  const q = knex('patient_accounts').where({ business_id: clinic.id, status: 'active' });
  if (isEmail(v)) q.where('login_email', v.toLowerCase());
  else { const p = phoneOf(v, await dialOf(clinic)); if (!p) return null; q.where('login_phone', p); }
  const rows = await q.limit(2);
  return rows.length === 1 ? rows[0] : null;
}

// ================================================================= sign-in
async function login(clinic, identifier, password, meta = {}) {
  const acc = await accountWith(clinic, identifier);
  const generic = () => new AppError('INVALID_CREDENTIALS', 'The mobile / e-mail or the password is not right.', 401);
  if (!acc || !acc.password_hash) { await bcrypt.compare(String(password || ''), dummy()); throw generic(); } // same time either way
  if (acc.locked_until && new Date(acc.locked_until) > now()) throw new AppError('ACCOUNT_LOCKED', 'Too many tries. Try again in 15 minutes.', 429);
  const ok = await bcrypt.compare(String(password || ''), acc.password_hash);
  if (!ok) {
    const n = acc.failed_count + 1;
    await knex('patient_accounts').where({ id: acc.id }).update({ failed_count: n >= MAX_TRIES ? 0 : n, locked_until: n >= MAX_TRIES ? new Date(Date.now() + LOCK_MS) : null });
    throw generic();
  }
  await knex('patient_accounts').where({ id: acc.id }).update({ failed_count: 0, locked_until: null, last_login_at: now() });
  await audit.record({ businessId: clinic.id, userId: null, ip: meta.ip }, 'patient_portal.login', { entityType: 'patient', entityId: acc.patient_id });
  return acc;
}

const PASSWORD = (p) => { if (String(p || '').length < 8) throw E.validation({ password: 'At least 8 characters.' }); };

/** Sets the patient's password (making the account when there is none) and its sign-in from the file. */
async function setPassword(clinic, patientId, password) {
  PASSWORD(password);
  const p = await knex('patients').where({ id: patientId, business_id: clinic.id }).first('id', 'phone', 'email');
  if (!p) throw E.notFound();
  const row = {
    login_phone: phoneOf(p.phone, await dialOf(clinic)), login_email: isEmail(p.email) ? String(p.email).trim().toLowerCase() : null,
    password_hash: await bcrypt.hash(String(password), config.bcryptRounds || 10), status: 'active', failed_count: 0, locked_until: null, updated_at: now(),
  };
  await knex('patient_accounts').insert({ business_id: clinic.id, patient_id: p.id, ...row }).onConflict(['business_id', 'patient_id']).merge(row);
  await audit.record({ businessId: clinic.id, userId: null }, 'patient_portal.password_set', { entityType: 'patient', entityId: p.id });
  return knex('patient_accounts').where({ business_id: clinic.id, patient_id: p.id }).first();
}

const CODE_TEXT = (clinic, code, locale) => (locale === 'en' ? `${clinic.displayName || clinic.name}: your code is ${code}. It expires in 10 minutes.` : `${clinic.displayName || clinic.name}: رمز التحقق ${code} — صالح لمدة 10 دقائق.`);
const mailHtml = (clinic, line) => `<p style="font-family:sans-serif">${String(clinic.displayName || clinic.name).replace(/[<>&]/g, '')}</p><p style="font-family:sans-serif;font-size:18px">${line}</p>`;

/**
 * Sends a sign-up / reset code to the mobile or e-mail typed, when it belongs to exactly one patient (sign-up) or one
 * account (reset). Returns the patient id to keep in the session for the next step, or null — the page says the same
 * either way ("if it is on the file, a code was sent").
 */
async function sendCode(clinic, purpose, identifier, channel, locale = 'ar') {
  const s = await settings(clinic.id);
  if (!s.enabled || (purpose === 'signup' && !s.self_signup)) throw E.notFound();
  const v = String(identifier || '').trim();
  let patientId = null;
  if (purpose === 'reset') { const acc = await accountWith(clinic, v); patientId = acc ? acc.patient_id : null; }
  else {
    const list = await patientsWith(clinic, v);
    if (list.length === 1) {
      const acc = await knex('patient_accounts').where({ business_id: clinic.id, patient_id: list[0].id }).first('password_hash');
      patientId = acc && acc.password_hash ? null : list[0].id; // has an account already: "forgot password" is the way
    }
  }
  if (!patientId) return null;
  const p = await knex('patients').where({ id: patientId, business_id: clinic.id }).first('phone', 'email');
  // the code goes to what is on the file — by e-mail only when the e-mail was typed (or chosen) and is on the file
  const ch = isEmail(v) ? 'email' : (['whatsapp', 'sms', 'email'].includes(channel) ? channel : 'sms');
  const code = await newCode(clinic.id, patientId, purpose, ch);
  const text = CODE_TEXT(clinic, code, locale);
  const sent = await deliver(clinic, ch, { phone: p.phone, email: p.email }, { text, code, subject: text, html: mailHtml(clinic, text) }).catch(() => false);
  await audit.record({ businessId: clinic.id, userId: null }, `patient_portal.${purpose}_code`, { entityType: 'patient', entityId: patientId, newValues: { channel: ch, sent } });
  return patientId;
}

// ================================================================= the clinic's invitation
/** Staff: an activation link for the patient (3 days, once) → { url, sent, waHref } — WhatsApp opens the member's own WhatsApp. */
async function invite(ctx, clinic, patientId, channel, base) {
  const s = await settings(ctx.businessId);
  if (!s.enabled) throw new AppError('PORTAL_OFF', 'Turn on the patient portal first (Settings → Patient portal).', 409);
  const p = await knex('patients').where({ id: patientId, business_id: ctx.businessId }).first('id', 'full_name', 'phone', 'email');
  if (!p) throw E.notFound();
  const token = crypto.randomBytes(24).toString('base64url');
  await knex('patient_account_codes').where({ business_id: ctx.businessId, patient_id: p.id, purpose: 'invite' }).whereNull('used_at').update({ used_at: now() });
  await knex('patient_account_codes').insert({ business_id: ctx.businessId, patient_id: p.id, purpose: 'invite', code_hash: sha(`invite:${token}`), channel, expires_at: new Date(Date.now() + LINK_MS) });
  const url = `${base}/${clinic.slug}/account/activate/${token}`;
  const name = clinic.displayName || clinic.name;
  const text = `${name}: ${ctx.locale === 'en' ? 'set your password to open your file' : 'فعّل حسابك بالضغط على الرابط'} ${url}`;
  let sent = false; let waHref = null;
  if (channel === 'whatsapp') {
    const to = phoneOf(p.phone, await dialOf(clinic));
    if (!to) throw E.validation({ channel: 'The patient has no valid mobile on the file.' });
    waHref = `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
  } else {
    sent = await deliver(clinic, channel, { phone: p.phone, email: p.email }, { text, subject: name, html: mailHtml(clinic, `<a href="${url}">${url}</a>`) }).catch(() => false);
    if (!sent) throw E.validation({ channel: channel === 'email' ? 'No e-mail on the file, or e-mail is not set up.' : 'No SMS provider, or no valid mobile on the file.' });
  }
  await audit.record(ctx, 'patient_portal.invited', { entityType: 'patient', entityId: p.id, newValues: { channel } });
  return { url, sent, waHref };
}
/** The patient of an activation link (still valid), or null. */
async function inviteFor(businessId, token) {
  const row = await knex('patient_account_codes').where({ business_id: businessId, purpose: 'invite', code_hash: sha(`invite:${String(token || '')}`) }).whereNull('used_at').where('expires_at', '>', now()).first();
  return row || null;
}
async function useInvite(clinic, token, password) {
  const row = await inviteFor(clinic.id, token);
  if (!row) throw new AppError('CODE_EXPIRED', 'The link expired. Ask the clinic for a new one.', 422);
  PASSWORD(password);
  await knex('patient_account_codes').where({ id: row.id }).update({ used_at: now() });
  return setPassword(clinic, row.patient_id, password);
}

// ================================================================= what the patient sees
async function home(clinic, patientId) {
  const s = await settings(clinic.id);
  const b = clinic.id;
  const p = await knex('patients').where({ id: patientId, business_id: b }).first('id', 'full_name', 'name_en', 'phone', 'email', 'date_of_birth', 'file_number');
  const doctorName = 'd.full_name as doctor_name';
  const out = { patient: p, s };
  if (s.show_visits) {
    out.visits = await knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').where({ 'a.business_id': b, 'a.patient_id': patientId })
      .whereNot('a.appointment_type', 'blocked').orderBy([{ column: 'a.appointment_date', order: 'desc' }, { column: 'a.appointment_time', order: 'desc' }]).limit(200)
      .select('a.id', 'a.appointment_date', 'a.appointment_time', 'a.status', doctorName, 'd.full_name_en as doctor_name_en');
  }
  if (s.show_records) {
    out.records = await knex('consultations as c').leftJoin('doctors as d', 'd.id', 'c.doctor_id').where({ 'c.business_id': b, 'c.patient_id': patientId })
      .orderBy('c.created_at', 'desc').limit(200).select('c.id', 'c.created_at', 'c.chief_complaint', 'c.diagnosis', 'c.assessment', 'c.plan_text', doctorName);
  }
  if (s.show_prescriptions) {
    out.prescriptions = (await knex('prescriptions as r').leftJoin('doctors as d', 'd.id', 'r.doctor_id').where({ 'r.business_id': b, 'r.patient_id': patientId })
      .orderBy('r.created_at', 'desc').limit(200).select('r.id', 'r.created_at', 'r.diagnosis', 'r.items', 'r.notes', doctorName))
      .map((r) => { let items = []; try { items = typeof r.items === 'string' ? JSON.parse(r.items) : (r.items || []); } catch { items = []; } return { ...r, items: Array.isArray(items) ? items : [] }; });
  }
  if (s.show_plan) {
    out.plan = await knex('dental_plan_items as i').leftJoin('doctors as d', 'd.id', 'i.doctor_id').where({ 'i.business_id': b, 'i.patient_id': patientId })
      .orderByRaw('COALESCE(i.done_on, DATE(i.created_at)) DESC').limit(500).select('i.id', 'i.tooth', 'i.procedure_name', 'i.status', 'i.done_on', 'i.created_at', doctorName).catch(() => []);
  }
  if (s.show_files) {
    const own = await knex('patient_files').where({ business_id: b, patient_id: patientId }).orderBy('created_at', 'desc').select('id', 'title', 'name', 'mime', 'size', 'created_at');
    const old = await knex('patient_attachments').where({ business_id: b, patient_id: patientId }).orderBy('uploaded_at', 'desc').select('id', 'original_filename as name', 'mime_type as mime', 'file_size as size', 'uploaded_at as created_at').catch(() => []);
    out.files = [...own.map((f) => ({ ...f, kind: 'f' })), ...old.map((f) => ({ ...f, kind: 'a' }))].sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
  }
  return out;
}

/** One of the patient's own files (when the clinic shows files) → { name, mime, data | stream }. */
async function fileOf(clinic, patientId, kind, id) {
  const s = await settings(clinic.id);
  if (!s.show_files) return null;
  if (kind === 'f') {
    const f = await knex('patient_files').where({ id: Number(id) || 0, business_id: clinic.id, patient_id: patientId }).first('name', 'mime', 'data');
    return f ? { name: f.name, mime: f.mime, data: f.data } : null;
  }
  const a = await knex('patient_attachments').where({ id: Number(id) || 0, business_id: clinic.id, patient_id: patientId }).first('original_filename', 'mime_type', 'storage_path');
  if (!a) return null;
  const files = require('../legacy/files'); // eslint-disable-line global-require
  return files.exists(a.storage_path) ? { name: a.original_filename, mime: a.mime_type, path: files.abs(a.storage_path) } : null;
}

module.exports = { DEFAULTS, SECTIONS, settings, saveSettings, channelsFor, login, setPassword, sendCode, checkCode, invite, inviteFor, useInvite, home, fileOf, accountWith, patientsWith, isEmail };
