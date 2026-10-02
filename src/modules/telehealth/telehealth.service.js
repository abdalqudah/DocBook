// ============================================================================
// Online consultations (telehealth).
//   • clinic settings (on/off, payment before confirmation, payment instructions, cancellation policy)
//   • per doctor: offers online consultations, online fee and length, weekly online windows, video method
//   • free online times: the scheduling engine with the online windows and length — every appointment of the
//     doctor (in the clinic or online) blocks, and booking takes the same slot lock, so there is no double booking
//   • booking from the public page (appointment type "online", source "website") with the patient's time zone,
//     country, reason and up to 5 files (PDF/JPEG/PNG, bytes checked, stored in the database, staff-only)
//   • the consultation link /c/<token>: an unguessable token; the database keeps its SHA-256 (look-ups) and the
//     token encrypted with APP_KEY (so staff can copy the link again) — never the token in clear
//   • state: pending → (awaiting payment) → confirmed (link e-mailed) → completed; cancelled
//   • join window, presence (the patient joining = arrived; skips the front-desk check-in)
//   • WebRTC signaling messages stored in telehealth_signals and read by short long-polling
//   • e-mails (only when SMTP is configured): received, confirmed (+ .ics), reminder ~1 h before, cancelled
// ============================================================================
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const brand = require('../../config/brand');
const audit = require('../../core/audit');
const { randomToken, sha256 } = require('../../core/tokens');
const mailer = require('../../core/mailer');
const { translator } = require('../../core/i18n');
const { z, validate, money, optionalString, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const scheduling = require('../clinic/scheduling');
const appts = require('../clinic/appointments.service');
const businesses = require('../businesses/business.service');
const notifications = require('../notifications/notification.service');
const countries = require('./countries');

const METHODS = ['builtin', 'jitsi', 'link'];
const JOIN_EARLY_MIN = 10;      // the patient can join 10 minutes before the start…
const GRACE_MIN = 15;           // …until 15 minutes after the planned end
const DOCTOR_EARLY_MIN = 30;    // the doctor can open the room a little earlier and stay longer
const DOCTOR_GRACE_MIN = 60;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SIGNAL_KINDS = ['hello', 'ready', 'offer', 'answer', 'ice', 'bye'];
const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_SIGNALS = 3000;
const PRESENCE_MS = 30_000;

// ---------------------------------------------------------------- time zones
/** A real IANA time-zone name (validated by the runtime, not only by shape). */
function isZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch { return false; }
}

/** UTC milliseconds of a wall-clock date + time in a time zone. */
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

/** { date: 'YYYY-MM-DD', time: 'HH:MM' } of an instant in a time zone. */
function partsIn(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}` };
}

/** A clinic date/time shown in another time zone: { date, time, utc, shift } (shift = days before/after). */
function toZone(date, time, fromTz, toTz) {
  const utc = zonedToUtc(date, time, fromTz);
  const p = partsIn(utc, toTz);
  const shift = Math.round((Date.parse(`${p.date}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  return { ...p, utc, shift };
}

function offsetLabel(tz, at = Date.now()) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date(at)).find((x) => x.type === 'timeZoneName');
    return part ? part.value : 'GMT';
  } catch { return 'GMT'; }
}

let zoneCache = { at: 0, list: [] };
/** Every IANA zone the runtime knows, as [{ value, label: 'Europe/Berlin (GMT+2)' }] (cached for an hour). */
function zoneOptions() {
  if (Date.now() - zoneCache.at > 3_600_000) {
    let names = [];
    try { names = Intl.supportedValuesOf('timeZone'); } catch { names = []; }
    if (!names.includes('UTC')) names = [...names, 'UTC'];
    zoneCache = { at: Date.now(), list: names.map((z0) => ({ value: z0, label: `${z0.replace(/_/g, ' ')} (${offsetLabel(z0)})` })) };
  }
  return zoneCache.list;
}

// ---------------------------------------------------------------- environment
/** STUN/TURN servers from ICE_SERVERS (JSON array of RTCIceServer), default: a public STUN server. */
function iceServers() {
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
  const raw = process.env.ICE_SERVERS;
  if (!raw) return fallback;
  try {
    const list = JSON.parse(raw);
    const okUrl = (u) => typeof u === 'string' && /^(stun|turn|turns):[^\s]+$/i.test(u);
    const clean = (Array.isArray(list) ? list : [list]).filter((s) => s && (okUrl(s.urls) || (Array.isArray(s.urls) && s.urls.length && s.urls.every(okUrl))))
      .map((s) => ({ urls: s.urls, ...(typeof s.username === 'string' ? { username: s.username } : {}), ...(typeof s.credential === 'string' ? { credential: s.credential } : {}) }));
    return clean.length ? clean : fallback;
  } catch { return fallback; }
}

/** The self-hosted Jitsi address from JITSI_URL (https only), or null. */
function jitsiBase() {
  const raw = String(process.env.JITSI_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'https:' ? `${u.origin}${u.pathname.replace(/\/+$/, '')}` : null; } catch { return null; }
}

/** The video method actually used: "jitsi" needs JITSI_URL, "link" needs the doctor's link — otherwise the built-in call. */
function effectiveMethod(d) {
  if (d.online_method === 'jitsi' && jitsiBase()) return 'jitsi';
  if (d.online_method === 'link' && d.online_link && /^https:\/\//i.test(d.online_link)) return 'link';
  return 'builtin';
}

/** The Jitsi room of a consultation: derived from the token hash with the server secret (not guessable). */
const jitsiRoom = (row) => `DocBook-${crypto.createHmac('sha256', config.sessionSecret).update(`jitsi:${row.token_hash}`).digest('hex').slice(0, 28)}`;

// ---------------------------------------------------------------- clinic settings
const bool = () => z.preprocess((v) => v === '1' || v === 'on' || v === true || v === 1, z.boolean());

function clinicSettings(b, locale) {
  const en = locale === 'en';
  const pick = (ar, enV) => (en ? enV || ar : ar || enV) || '';
  return {
    enabled: Boolean(b.online_enabled), paymentRequired: Boolean(b.online_payment_required),
    instructions: pick(b.online_payment_instructions, b.online_payment_instructions_en),
    policy: pick(b.online_cancellation_policy, b.online_cancellation_policy_en),
  };
}

const settingsSchema = z.object({
  online_enabled: bool(), online_payment_required: bool(),
  online_payment_instructions: optionalString(3000), online_payment_instructions_en: optionalString(3000),
  online_cancellation_policy: optionalString(3000), online_cancellation_policy_en: optionalString(3000),
});
const SETTINGS_FIELDS = Object.keys(settingsSchema.shape);

async function saveSettings(ctx, input) {
  const d = validate(settingsSchema, input);
  if (d.online_payment_required && !d.online_payment_instructions && !d.online_payment_instructions_en) {
    throw E.validation({ online_payment_instructions: 'Required.' });
  }
  const patch = Object.fromEntries(SETTINGS_FIELDS.map((k) => [k, d[k] === undefined ? null : d[k]]));
  const before = await knex('businesses').where({ id: ctx.businessId }).first(SETTINGS_FIELDS);
  const { oldValues, newValues, changed } = audit.diff(before, patch);
  if (!changed) return;
  await knex('businesses').where({ id: ctx.businessId }).update({ ...patch, updated_at: new Date() });
  await audit.record(ctx, 'clinic.telehealth_updated', { entityType: 'clinic', entityId: ctx.businessId, oldValues, newValues });
  businesses.forget(ctx.businessId);
}

// ---------------------------------------------------------------- doctors
const doctorSchema = z.object({
  online_enabled: bool(),
  online_fee: z.preprocess(emptyToUndefined, money().optional()),
  online_duration_minutes: z.preprocess(emptyToUndefined, z.coerce.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(5, 'Too small.').max(240, 'Too large.').optional()),
  online_method: z.preprocess((v) => emptyToUndefined(v) || 'builtin', z.enum(METHODS, { errorMap: () => ({ message: 'Choose a valid value.' }) })),
  online_link: z.preprocess(emptyToUndefined, z.string().trim().max(500).url('Enter a valid URL.').refine((v) => /^https:\/\//i.test(v), 'Use an https:// URL.').optional()),
});

/** Weekly online windows from the doctor form: ow[<day>][enabled|s1|e1|s2|e2]. */
function parseWindowsForm(src = {}) {
  const out = [];
  scheduling.DAY_KEYS.forEach((k) => {
    const d = src[k] || {};
    if (d.enabled !== '1') return;
    const pairs = [[d.s1, d.e1], [d.s2, d.e2]].filter(([s, e]) => s || e);
    if (!pairs.length) throw E.validation({ [`ow.${k}`]: 'Enter a valid time.' });
    pairs.forEach(([s, e]) => {
      if (!scheduling.isTime(s) || !scheduling.isTime(e) || scheduling.timeToMinutes(e) <= scheduling.timeToMinutes(s)) throw E.validation({ [`ow.${k}`]: 'Enter a valid time.' });
    });
    if (pairs.length === 2 && scheduling.overlaps(...pairs.flat().map(scheduling.timeToMinutes))) throw E.validation({ [`ow.${k}`]: 'Enter a valid time.' });
    pairs.forEach(([start, end]) => out.push({ weekday: k, start_time: start, end_time: end }));
  });
  return out;
}

/** Validates the online part of the doctor form (before anything is saved). */
function parseDoctorOnline(input) {
  const d = validate(doctorSchema, input);
  if (d.online_enabled && d.online_method === 'link' && !d.online_link) throw E.validation({ online_link: 'Required.' });
  return {
    row: { online_enabled: d.online_enabled, online_fee: d.online_fee === undefined ? null : d.online_fee, online_duration_minutes: d.online_duration_minutes || null, online_method: d.online_method, online_link: d.online_link || null },
    windows: parseWindowsForm(input.ow),
  };
}

async function applyDoctorOnline(ctx, doctorId, parsed) {
  await knex.transaction(async (trx) => {
    const doc = await trx('doctors').where({ id: doctorId, business_id: ctx.businessId }).first('id');
    if (!doc) throw E.notFound('Doctor');
    await trx('doctors').where({ id: doctorId, business_id: ctx.businessId }).update({ ...parsed.row, updated_at: new Date() });
    await trx('doctor_online_slots').where({ business_id: ctx.businessId, doctor_id: doctorId }).del();
    if (parsed.windows.length) await trx('doctor_online_slots').insert(parsed.windows.map((w) => ({ ...w, business_id: ctx.businessId, doctor_id: doctorId })));
    await audit.record(ctx, 'doctor.online_updated', { entityType: 'doctor', entityId: doctorId, newValues: { ...parsed.row, windows: parsed.windows.map((w) => `${w.weekday} ${w.start_time}-${w.end_time}`).join(', ') } }, trx);
  });
}

const windowsOf = (businessId, doctorId) => knex('doctor_online_slots').where({ business_id: businessId, doctor_id: doctorId }).orderBy([{ column: 'weekday' }, { column: 'start_time' }]).select('weekday', 'start_time', 'end_time');

/** { sun: [{ start, end }], … } */
function windowsByDay(rows) {
  const out = Object.fromEntries(scheduling.DAY_KEYS.map((k) => [k, []]));
  rows.forEach((r) => { if (out[r.weekday]) out[r.weekday].push({ start: r.start_time, end: r.end_time }); });
  Object.values(out).forEach((l) => l.sort((a, b) => (a.start < b.start ? -1 : 1)));
  return out;
}

/** Online windows as a working-hours object for the scheduling engine (null = use the doctor's working hours). */
function windowsToWorkingHours(rows) {
  if (!rows || !rows.length) return null;
  const by = windowsByDay(rows);
  return Object.fromEntries(Object.entries(by).map(([k, shifts]) => [k, { enabled: shifts.length > 0, shifts, breaks: [] }]));
}

/** A doctor's online settings with the defaults applied. */
function doctorOnline(d) {
  return {
    enabled: Boolean(d.online_enabled),
    fee: d.online_fee !== null && d.online_fee !== undefined ? Number(d.online_fee) : Number(d.consultation_fee) || 0,
    duration: Number(d.online_duration_minutes) || Number(d.slot_duration_minutes) || 30,
    method: d.online_method || 'builtin', link: d.online_link || null,
  };
}

// ---------------------------------------------------------------- public: doctors & free times
async function onlineDoctors(clinic, locale) {
  if (!clinic.online_enabled) return [];
  const en = locale === 'en';
  const rows = await knex('doctors').where({ business_id: clinic.id, is_active: true, online_enabled: true }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }]);
  return rows.map((d) => {
    const o = doctorOnline(d);
    return {
      id: d.id, name: (en && d.full_name_en) || d.full_name, specialty: (en ? d.specialization_en || d.specialization : d.specialization || d.specialization_en) || '',
      fee: o.fee, duration: o.duration,
    };
  });
}

function slotRequest(clinic, doctor, windows, date, time) {
  const o = doctorOnline(doctor);
  return {
    businessId: clinic.id, timezone: clinic.timezone, doctorId: doctor.id, date, time,
    durationOverride: o.duration, slotStep: o.duration, workingHours: windowsToWorkingHours(windows) || undefined,
  };
}

async function onlineDoctor(businessId, doctorId) {
  return knex('doctors').where({ id: doctorId, business_id: businessId, is_active: true, online_enabled: true }).first();
}

/** Free online start times (clinic time) for a doctor on a clinic date. */
async function onlineSlots(clinic, doctorId, date) {
  const doctor = await onlineDoctor(clinic.id, doctorId);
  if (!doctor || !clinic.online_enabled) throw E.validation({ doctor_id: 'Choose a valid value.' });
  const windows = await windowsOf(clinic.id, doctor.id);
  return scheduling.availableSlots(slotRequest(clinic, doctor, windows, date));
}

/** Each clinic slot with the same moment in the patient's time zone. */
const slotsInZone = (slots, date, clinicTz, patientTz) => slots.map((time) => {
  const p = toZone(date, time, clinicTz, patientTz);
  return { time, local: p.time, localDate: p.date, shift: p.shift, utc: p.utc };
});

// ---------------------------------------------------------------- files
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILE_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' };

/** File type from its first bytes (never from the name or the browser's claim). */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  return null;
}

/** Checks uploaded files (multer memory files); returns the rows to store or throws a 422 with a code. */
function checkFiles(files) {
  const list = (files || []).filter((f) => f && f.buffer && f.size > 0);
  if (list.length > MAX_FILES) throw new AppError('TELE_TOO_MANY_FILES', 'Too many files.', 422, { files: 'TELE_TOO_MANY_FILES' });
  return list.map((f) => {
    if (f.size > MAX_FILE_BYTES || f.buffer.length > MAX_FILE_BYTES) throw new AppError('TELE_FILE_TOO_BIG', 'File too large.', 422, { files: 'TELE_FILE_TOO_BIG' });
    const kind = sniff(f.buffer);
    if (!kind) throw new AppError('TELE_FILE_TYPE', 'Unsupported file type.', 422, { files: 'TELE_FILE_TYPE' });
    const base = String(f.originalname || 'file').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim().slice(0, 100) || 'file';
    return { name: `${base}.${kind}`, mime: FILE_TYPES[kind], size: f.buffer.length, sha256: crypto.createHash('sha256').update(f.buffer).digest('hex'), data: f.buffer };
  });
}

// ---------------------------------------------------------------- phone
/** "+<code><number>" from a dial code and the number typed (a leading + in the number wins). Null when invalid. */
function normalizePhone(code, number) {
  const raw = String(number || '').trim().replace(/[\s().-]/g, '');
  let full;
  if (raw.startsWith('+')) full = raw;
  else if (raw.startsWith('00')) full = `+${raw.slice(2)}`;
  else {
    if (!countries.isDial(code)) return null;
    full = `+${code}${raw.replace(/^0+/, '')}`;
  }
  return /^\+[1-9][0-9]{6,14}$/.test(full) ? full : null;
}

// ---------------------------------------------------------------- tokens & look-ups
// The link token is kept encrypted (AES-256-GCM, key derived from APP_KEY or SESSION_SECRET) so staff can copy the
// link again; look-ups use its SHA-256. If the secret changes, a new link is issued the next time staff open it.
let linkKey;
const keyOf = () => {
  if (!linkKey) linkKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(process.env.APP_KEY || config.sessionSecret), Buffer.from('telehealth'), Buffer.from('consultation-link-v1'), 32));
  return linkKey;
};
const secrets = {
  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keyOf(), iv);
    const data = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  },
  decrypt(payload) {
    try {
      const [v, iv, tag, data] = String(payload || '').split(':');
      if (v !== 'v1') return null;
      const d = crypto.createDecipheriv('aes-256-gcm', keyOf(), Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
    } catch { return null; }
  },
};
const newToken = () => { const token = randomToken(32); return { token, token_hash: sha256(token), token_enc: secrets.encrypt(token) }; };

const ROW_SELECT = ['oc.*', 'a.patient_name', 'a.patient_email', 'a.patient_phone', 'a.patient_id', 'a.doctor_id', 'a.appointment_date', 'a.appointment_time', 'a.duration_minutes',
  'a.status', 'a.payment_status', 'a.amount_due', 'a.appointment_type', 'a.checked_in', 'a.with_doctor', 'a.service_id',
  'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.specialization as doctor_spec', 'd.specialization_en as doctor_spec_en',
  'd.online_method', 'd.online_link', 'd.slot_duration_minutes', 'd.online_duration_minutes'];

const rowQuery = () => knex('online_consultations as oc').join('appointments as a', 'a.id', 'oc.appointment_id').leftJoin('doctors as d', 'd.id', 'a.doctor_id')
  .where('a.appointment_type', 'online');

/** The consultation for a link token (null when the token is malformed or unknown). */
async function byToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const row = await rowQuery().where('oc.token_hash', sha256(String(token))).first(ROW_SELECT);
  if (!row) return null;
  // The link (patient details, shared documents) stops working 30 days after the consultation date.
  const day = String(row.appointment_date || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Date.parse(`${day}T23:59:59Z`) + LINK_DAYS_AFTER * 86_400_000 < Date.now()) return null;
  return row;
}
const LINK_DAYS_AFTER = 30;

const byId = (businessId, id) => rowQuery().where({ 'oc.id': id, 'oc.business_id': businessId }).first(ROW_SELECT);

/**
 * The consultation of an online appointment the caller may see (appointments.get enforces the clinic and a
 * doctor's own schedule). Created on first use for online appointments booked by staff.
 * @returns {{ row, token }}
 */
async function forAppointment(ctx, apptOrId) {
  const a = typeof apptOrId === 'object' ? apptOrId : await appts.get(ctx, Number(apptOrId));
  if (a.appointment_type !== 'online') throw E.notFound('Online consultation');
  let row = await rowQuery().where({ 'oc.appointment_id': a.id, 'oc.business_id': ctx.businessId }).first(ROW_SELECT);
  if (!row) {
    const t = newToken();
    await knex('online_consultations').insert({ business_id: ctx.businessId, appointment_id: a.id, token_hash: t.token_hash, token_enc: t.token_enc, locale: ctx.locale === 'en' ? 'en' : 'ar' })
      .onConflict('appointment_id').ignore();
    row = await rowQuery().where({ 'oc.appointment_id': a.id, 'oc.business_id': ctx.businessId }).first(ROW_SELECT);
  }
  let token = secrets.decrypt(row.token_enc);
  if (!token || sha256(token) !== row.token_hash) { // APP_KEY changed: issue a new link
    const t = newToken();
    await knex('online_consultations').where({ id: row.id }).update({ token_hash: t.token_hash, token_enc: t.token_enc, updated_at: new Date() });
    row = { ...row, token_hash: t.token_hash, token_enc: t.token_enc };
    token = t.token;
  }
  return { row, token };
}

const linkFor = (base, token) => `${String(base || config.appUrl).replace(/\/+$/, '')}/c/${token}`;

// ---------------------------------------------------------------- state & join window
/** pending | awaiting_payment | confirmed | completed | cancelled */
function stateOf(row) {
  if (row.status === 'cancelled' || row.status === 'no_show') return 'cancelled';
  if (row.status === 'completed') return 'completed';
  if (row.status === 'pending') return row.payment_required && row.payment_status !== 'paid' ? 'awaiting_payment' : 'pending';
  return 'confirmed';
}

const lengthOf = (row) => Number(row.duration_minutes) || Number(row.online_duration_minutes) || Number(row.slot_duration_minutes) || 30;

/** Start/end and the join window (ms) for the patient or the doctor. */
function windowOf(row, clinicTz, who = 'patient', now = Date.now()) {
  const startMs = zonedToUtc(row.appointment_date, row.appointment_time, clinicTz);
  const endMs = startMs + lengthOf(row) * 60_000;
  const openMs = startMs - (who === 'doctor' ? DOCTOR_EARLY_MIN : JOIN_EARLY_MIN) * 60_000;
  const closeMs = endMs + (who === 'doctor' ? DOCTOR_GRACE_MIN : GRACE_MIN) * 60_000;
  return { startMs, endMs, openMs, closeMs, now, isOpen: now >= openMs && now <= closeMs, phase: now < openMs ? 'early' : now > closeMs ? 'over' : 'open' };
}

/** Whether this side may join / exchange signaling messages right now. */
function canJoin(row, clinicTz, who, now = Date.now()) {
  const st = stateOf(row);
  if (who === 'patient' ? st !== 'confirmed' : !['confirmed', 'pending'].includes(st)) return false;
  return windowOf(row, clinicTz, who, now).isOpen;
}

// ---------------------------------------------------------------- booking
/**
 * Books an online consultation from the public page (input already validated by the router).
 * @param ctx   public clinic context ({ businessId, timezone, ip, userAgent, locale })
 * @param d     { doctor_id, appointment_date, appointment_time, patient_name, patient_phone, patient_email, patient_country, patient_timezone, reason }
 * @param files rows from checkFiles()
 */
async function bookOnline(ctx, clinic, d, files = []) {
  if (!clinic.online_enabled) throw E.validation({ doctor_id: 'Choose a valid value.' });
  const doctor = await onlineDoctor(clinic.id, d.doctor_id);
  if (!doctor) throw E.validation({ doctor_id: 'Choose a valid value.' });
  const windows = await windowsOf(clinic.id, doctor.id);
  const o = doctorOnline(doctor);
  const t = newToken();
  const payReq = Boolean(clinic.online_payment_required);
  const ids = await scheduling.withSlot(slotRequest(clinic, doctor, windows, d.appointment_date, d.appointment_time), async (trx) => {
    const patientId = await appts.resolveOrCreatePatient(ctx, { name: d.patient_name, phone: d.patient_phone, email: d.patient_email }, trx);
    const [apptId] = await trx('appointments').insert({
      business_id: clinic.id, branch_id: doctor.branch_id || null, doctor_id: doctor.id, service_id: null, patient_id: patientId,
      patient_name: d.patient_name, patient_phone: d.patient_phone, patient_email: d.patient_email,
      appointment_date: d.appointment_date, appointment_time: d.appointment_time, duration_minutes: o.duration,
      status: 'pending', appointment_type: 'online', source: 'website', amount_due: o.fee, notes: null, created_by: null,
    });
    await audit.record(ctx, 'appointment.created', { entityType: 'appointment', entityId: apptId, newValues: { date: d.appointment_date, time: d.appointment_time, doctor_id: doctor.id, source: 'website', type: 'online' } }, trx);
    const [cid] = await trx('online_consultations').insert({
      business_id: clinic.id, appointment_id: apptId, token_hash: t.token_hash, token_enc: t.token_enc,
      patient_timezone: d.patient_timezone, patient_country: d.patient_country, reason: d.reason, payment_required: payReq, locale: ctx.locale === 'en' ? 'en' : 'ar',
    });
    for (const f of files) await trx('online_consultation_files').insert({ business_id: clinic.id, consultation_id: cid, ...f }); // eslint-disable-line no-await-in-loop
    return { apptId, cid };
  });
  await notifications.notify(clinic.id, {
    permission: 'appointments.manage', type: 'appointment.booked_online', severity: 'info',
    title: `${d.patient_name} · ${d.appointment_date} ${d.appointment_time}`, body: 'telehealth', link: `/app/appointments/${ids.apptId}`,
  });
  return { appointmentId: ids.apptId, consultationId: ids.cid, token: t.token };
}

// ---------------------------------------------------------------- presence & signaling
async function markJoined(row, who) {
  const now = new Date();
  if (who === 'patient') {
    await knex('online_consultations').where({ id: row.id }).update({ patient_seen_at: now, ...(row.patient_joined_at ? {} : { patient_joined_at: now }) });
    // Online patients skip the front-desk check-in: joining the call means they have arrived.
    if (!row.checked_in) await knex('appointments').where({ id: row.appointment_id, business_id: row.business_id }).update({ checked_in: true, arrived_at: now, updated_at: now });
  } else {
    await knex('online_consultations').where({ id: row.id }).update({ doctor_seen_at: now, ...(row.doctor_joined_at ? {} : { doctor_joined_at: now }) });
    if (!row.with_doctor) await knex('appointments').where({ id: row.appointment_id, business_id: row.business_id }).update({ with_doctor: true, called_at: now, updated_at: now });
  }
}

async function postSignal(row, sender, kind, payload) {
  if (!SIGNAL_KINDS.includes(kind)) throw E.validation({ kind: 'Choose a valid value.' });
  let text = null;
  if (payload !== undefined && payload !== null && payload !== '') {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (Buffer.byteLength(text) > MAX_SIGNAL_BYTES) throw new AppError('TELE_SIGNAL_TOO_BIG', 'Message too large.', 413);
    try { JSON.parse(text); } catch { throw E.validation({ payload: 'Choose a valid value.' }); }
  }
  const [{ n }] = await knex('telehealth_signals').where({ consultation_id: row.id }).count({ n: '*' });
  if (Number(n) >= MAX_SIGNALS) throw new AppError('TELE_SIGNAL_LIMIT', 'Too many messages.', 429);
  const [id] = await knex('telehealth_signals').insert({ consultation_id: row.id, sender, kind, payload: text });
  // "bye" = this side left: it no longer counts as present in the room.
  await knex('online_consultations').where({ id: row.id }).update({ [`${sender}_seen_at`]: kind === 'bye' ? null : new Date() });
  return id;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Messages from the other side newer than `after`. Without `after`, returns only the current cursor.
 * Waits up to `waitMs` for something new (short long-polling).
 */
async function pollSignals(row, me, after, waitMs = 20_000) {
  const other = me === 'doctor' ? 'patient' : 'doctor';
  const presence = async () => {
    const fresh = await knex('online_consultations').where({ id: row.id }).first('patient_seen_at', 'doctor_seen_at');
    const seen = fresh && fresh[`${other}_seen_at`];
    return { peer: Boolean(seen && Date.now() - new Date(seen).getTime() < PRESENCE_MS) };
  };
  await knex('online_consultations').where({ id: row.id }).update(me === 'patient' ? { patient_seen_at: new Date() } : { doctor_seen_at: new Date() });
  if (after === null || after === undefined || !Number.isFinite(Number(after)) || Number(after) < 0) {
    const r = await knex('telehealth_signals').where({ consultation_id: row.id }).max({ m: 'id' }).first();
    return { messages: [], last: Number((r && r.m) || 0), ...await presence() };
  }
  const deadline = Date.now() + Math.max(0, Math.min(waitMs, 25_000));
  for (;;) {
    const rows = await knex('telehealth_signals').where({ consultation_id: row.id, sender: other }).where('id', '>', Number(after)).orderBy('id').limit(100).select('id', 'kind', 'payload'); // eslint-disable-line no-await-in-loop
    if (rows.length || Date.now() >= deadline) {
      return {
        messages: rows.map((m) => ({ id: Number(m.id), kind: m.kind, payload: m.payload ? JSON.parse(m.payload) : null })),
        last: rows.length ? Number(rows[rows.length - 1].id) : Number(after), ...await presence(), // eslint-disable-line no-await-in-loop
      };
    }
    await sleep(500); // eslint-disable-line no-await-in-loop
  }
}

async function purgeSignals(olderThanMs = 24 * 3_600_000) {
  return knex('telehealth_signals').where('created_at', '<', new Date(Date.now() - olderThanMs)).del();
}

// ---------------------------------------------------------------- staff views
async function filesOf(businessId, consultationId) {
  return knex('online_consultation_files').where({ business_id: businessId, consultation_id: consultationId }).orderBy('id').select('id', 'name', 'mime', 'size', 'created_at');
}
const fileOf = (businessId, consultationId, fileId) => knex('online_consultation_files').where({ business_id: businessId, consultation_id: consultationId, id: fileId }).first();

// ---------------------------------------------------------------- e-mail
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function when(ms, tz, locale) {
  const loc = locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
  try {
    return new Intl.DateTimeFormat(loc, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  } catch { const p = partsIn(ms, tz); return `${p.date} ${p.time}`; }
}

function mailHtml({ locale, clinicName, title, intro, rows = [], blocks = [], cta, href, foot }) {
  const c = brand.colors.light;
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const align = locale === 'ar' ? 'right' : 'left';
  return `<!doctype html><html dir="${dir}"><body style="margin:0;background:${c.background};font-family:Arial,Tahoma,sans-serif;color:${c.text}">
<div style="max-width:560px;margin:24px auto;background:${c.surface};border:1px solid ${c.border};border-radius:12px;padding:28px;text-align:${align}">
<div style="font-weight:700;font-size:16px;margin-bottom:18px">${esc(clinicName)}</div>
<h1 style="font-size:18px;margin:0 0 12px">${esc(title)}</h1><p style="line-height:1.7;margin:0 0 16px">${esc(intro)}</p>
${rows.length ? `<table style="border-collapse:collapse;width:100%;margin:0 0 16px">${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:${c.textMuted || c.text};width:40%;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>` : ''}
${blocks.map((b) => `<div style="border-top:1px solid ${c.border};padding-top:12px;margin-top:12px"><div style="font-weight:700;margin-bottom:6px">${esc(b.title)}</div><div style="white-space:pre-line;line-height:1.7">${esc(b.text)}</div></div>`).join('')}
${cta ? `<p style="margin:20px 0 8px"><a href="${esc(href)}" style="display:inline-block;background:${c.primary};color:${c.primaryInk};padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:700">${esc(cta)}</a></p><p style="font-size:12px;color:${c.textMuted || c.text};word-break:break-all" dir="ltr">${esc(href)}</p>` : ''}
${foot ? `<p style="font-size:12px;color:${c.textMuted || c.text};margin-top:20px">${esc(foot)}</p>` : ''}
<div style="font-size:11px;color:${c.textMuted || c.text};margin-top:24px">${esc(brand.name)}</div>
</div></body></html>`;
}

const icsDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** Calendar file (UTC times, so every calendar shows it in its own time zone). */
function icsFor(row, clinic, link, t) {
  const tz = clinic.timezone || 'UTC';
  const start = zonedToUtc(row.appointment_date, row.appointment_time, tz);
  const end = start + lengthOf(row) * 60_000;
  const host = String(config.appUrl || 'localhost').replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  const clinicName = (row.locale === 'en' && clinic.name_en) || clinic.name;
  const doctor = (row.locale === 'en' && row.doctor_name_en) || row.doctor_name || '';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DocBook//Online consultation//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:online-${row.appointment_id}@${host}`, `DTSTAMP:${icsDate(Date.now())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(t('telehealth.ics_summary', { clinic: clinicName }))}`,
    `DESCRIPTION:${icsText([doctor, link].filter(Boolean).join('\n'))}`,
    ...(link ? [`URL:${link}`, `LOCATION:${icsText(link)}`] : []),
    `STATUS:${stateOf(row) === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE'}`, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

/**
 * E-mails the patient (received | confirmed | reminder | cancelled) in their language and time zone.
 * Returns true when sent, false when e-mail is not configured or there is no address.
 */
async function sendPatientMail(kind, row, clinic, token, base) {
  if (!row.patient_email || !(await mailer.configuredFor(clinic.id))) return false;
  const locale = row.locale === 'en' ? 'en' : 'ar';
  const t = translator(locale);
  const tz = isZone(row.patient_timezone) ? row.patient_timezone : clinic.timezone;
  const startMs = zonedToUtc(row.appointment_date, row.appointment_time, clinic.timezone);
  const clinicName = (locale === 'en' && clinic.name_en) || clinic.name;
  const doctor = (locale === 'en' && row.doctor_name_en) || row.doctor_name || '—';
  const link = linkFor(base, token);
  const s = clinicSettings(clinic, locale);
  const rows = [
    [t('telehealth.mail.doctor'), doctor],
    [t('telehealth.mail.your_time'), `${when(startMs, tz, locale)} (${tz})`],
    ...(tz !== clinic.timezone ? [[t('telehealth.mail.clinic_time'), `${when(startMs, clinic.timezone, locale)} (${clinic.timezone})`]] : []),
    [t('telehealth.mail.length'), t('telehealth.minutes', { n: lengthOf(row) })],
  ];
  const blocks = [];
  const unpaid = row.payment_status !== 'paid' && Number(row.amount_due) > 0;
  if (unpaid && (row.payment_required || kind === 'received') && s.instructions) blocks.push({ title: t('telehealth.payment_title'), text: s.instructions });
  if (s.policy && kind !== 'cancelled') blocks.push({ title: t('telehealth.policy_title'), text: s.policy });
  const subject = t(`telehealth.mail.${kind}_subject`, { clinic: clinicName });
  const intro = kind === 'received' && stateOf(row) === 'awaiting_payment' ? t('telehealth.mail.received_pay_intro') : t(`telehealth.mail.${kind}_intro`);
  const html = mailHtml({
    locale, clinicName, title: subject, intro, rows, blocks,
    cta: kind === 'cancelled' ? null : t(kind === 'received' ? 'telehealth.mail.view_booking' : 'telehealth.mail.open_link'), href: link,
    foot: t('telehealth.mail.foot'),
  });
  const attachments = kind === 'confirmed' ? [{ filename: 'consultation.ics', content: icsFor(row, clinic, link, t), contentType: 'text/calendar; charset=utf-8' }] : undefined;
  await mailer.send({ to: row.patient_email, subject, html, replyTo: clinic.email || undefined, attachments, businessId: clinic.id, kind: 'telehealth' });
  return true;
}

/** Sends the confirmation (link) e-mail and records it. Returns true when an e-mail went out. */
async function sendLink(ctx, apptOrId, base) {
  const { row, token } = await forAppointment(ctx, apptOrId);
  const clinic = await businesses.get(row.business_id);
  const sent = await sendPatientMail('confirmed', row, clinic, token, base);
  if (sent) {
    await knex('online_consultations').where({ id: row.id }).update({ link_sent_at: new Date(), updated_at: new Date() });
    await audit.record(ctx, 'telehealth.link_sent', { entityType: 'appointment', entityId: row.appointment_id });
  }
  return sent;
}

/** Hook from appointments.setStatus: confirmation → link e-mail (once); cancellation → notice. Never throws. */
async function statusChanged(ctx, appt, status) {
  try {
    if (!appt || appt.appointment_type !== 'online') return;
    if (status === 'confirmed' && appt.status !== 'confirmed') {
      const { row } = await forAppointment(ctx, appt);
      if (!row.link_sent_at) await sendLink(ctx, appt, ctx.baseUrl);
    } else if (status === 'cancelled' && appt.status !== 'cancelled') {
      const { row, token } = await forAppointment(ctx, appt);
      const clinic = await businesses.get(row.business_id);
      if (await sendPatientMail('cancelled', { ...row, status: 'cancelled' }, clinic, token, ctx.baseUrl)) {
        await knex('online_consultations').where({ id: row.id }).update({ cancel_sent_at: new Date() });
      }
    }
  } catch (err) {
    console.error('[telehealth] e-mail failed:', err.message); // eslint-disable-line no-console
  }
}

/** Interval job: reminder e-mails ~1 hour before confirmed consultations, and old signaling messages purged. */
async function runDue(now = Date.now()) {
  await purgeSignals();
  if (!mailer.configured()) return 0;
  const from = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now + 2 * 86_400_000).toISOString().slice(0, 10);
  const rows = await rowQuery().where('a.status', 'confirmed').whereNull('oc.reminder_sent_at').whereNotNull('a.patient_email')
    .whereBetween('a.appointment_date', [from, to]).select(ROW_SELECT);
  let sent = 0;
  for (const row of rows) {
    const clinic = await businesses.get(row.business_id); // eslint-disable-line no-await-in-loop
    const startMs = zonedToUtc(row.appointment_date, row.appointment_time, clinic.timezone);
    const lead = startMs - now;
    if (lead <= 0 || lead > 65 * 60_000) continue; // eslint-disable-line no-continue
    const token = secrets.decrypt(row.token_enc);
    if (!token) continue; // eslint-disable-line no-continue
    try {
      if (await sendPatientMail('reminder', row, clinic, token, config.appUrl)) { // eslint-disable-line no-await-in-loop
        await knex('online_consultations').where({ id: row.id }).update({ reminder_sent_at: new Date() }); // eslint-disable-line no-await-in-loop
        sent += 1;
      }
    } catch (err) { console.error('[telehealth] reminder failed:', err.message); } // eslint-disable-line no-console
  }
  return sent;
}

module.exports = {
  METHODS, JOIN_EARLY_MIN, GRACE_MIN, DOCTOR_EARLY_MIN, DOCTOR_GRACE_MIN, MAX_FILES, MAX_FILE_BYTES, TOKEN_RE, SIGNAL_KINDS,
  isZone, zonedToUtc, partsIn, toZone, offsetLabel, zoneOptions, iceServers, jitsiBase, effectiveMethod, jitsiRoom,
  clinicSettings, saveSettings, parseDoctorOnline, applyDoctorOnline, parseWindowsForm, windowsOf, windowsByDay, windowsToWorkingHours, doctorOnline,
  onlineDoctors, onlineDoctor, onlineSlots, slotsInZone, sniff, checkFiles, normalizePhone,
  byToken, byId, forAppointment, linkFor, stateOf, lengthOf, windowOf, canJoin, bookOnline,
  markJoined, postSignal, pollSignals, purgeSignals, filesOf, fileOf,
  sendPatientMail, sendLink, statusChanged, runDue, icsFor, when,
};
