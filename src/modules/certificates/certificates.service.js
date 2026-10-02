// Medical documents issued from a visit: sick leave, medical report and attendance certificate.
//
// • Issuing: only people with certificates.issue, for a visit they can open (a doctor login without
//   appointments.view_all only for their own visits — appointments.get enforces it). The document is signed in the
//   name of the visit's doctor (or the issuer's own doctor profile when the visit has none).
// • Every document gets a per-clinic serial per type and year (SL-2026-000123) and an unguessable verification code
//   (16 characters, 80 bits) printed as a QR code pointing to /verify/<code>.
// • The content is a snapshot and is never edited: a mistake is corrected by revoking (reason, audited) and issuing
//   a new document (replaces_id keeps the link). Nothing is deleted.
// • The public verification page gets only publicView(): status, clinic, doctor, type, serial, issue date, leave
//   period and a masked patient name — never the diagnosis, report text, phone or national ID.
const crypto = require('crypto');
const QRCode = require('qrcode');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { z, validate, isoDate, optionalString, emptyToUndefined } = require('../../core/validate');
const appts = require('../clinic/appointments.service');

const TYPES = ['sick_leave', 'medical_report', 'attendance'];
const PREFIX = { sick_leave: 'SL', medical_report: 'MR', attendance: 'AC' };
const MAX_LEAVE_DAYS = 30;
const MAX_ATTACHMENTS = 20;
// No 0/O or 1/I so a code typed from paper is not misread. 32 symbols × 16 characters = 80 bits.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 16;

// ---------------------------------------------------------------- small helpers
function newCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i += 1) out += ALPHABET[bytes[i] % 32];
  return out;
}
/** Accepts "ABCD-EFGH-…", lower case, spaces; returns the 16-character code or null. */
function normalizeCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[\s-]+/g, '');
  if (s.length !== CODE_LEN) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}
const formatCode = (code) => String(code || '').replace(/(.{4})(?=.)/g, '$1-');
/** "SL-2026-000123" (any case, extra spaces) or null. */
function normalizeSerial(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, '');
  return /^(SL|MR|AC)-\d{4}-\d{6,}$/.test(s) ? s : null;
}
const serialOf = (type, year, n) => `${PREFIX[type]}-${year}-${String(n).padStart(6, '0')}`;

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "محمد عبد الله أحمد" → "محمد ع*** ا*** أ***"; a one-word name keeps only its first letter. */
function maskName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '—';
  const initial = (w) => `${Array.from(w)[0]}***`;
  if (words.length === 1) return initial(words[0]);
  return [words[0], ...words.slice(1).map(initial)].join(' ');
}

function localTime(tz, d) {
  if (!d) return null;
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });
  return f.format(new Date(d)).replace(/^24/, '00');
}
const addMinutes = (hhmm, m) => {
  const [h, mi] = String(hhmm).split(':').map(Number);
  const t = Math.min(23 * 60 + 59, h * 60 + mi + m);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

const hashOf = (row) => crypto.createHash('sha256').update(JSON.stringify([
  row.business_id, row.doc_type, row.serial, row.verify_code, row.language, row.patient_name, row.patient_national_id, row.doctor_name,
  row.doctor_license, row.visit_date, row.time_from, row.time_to, row.leave_start, row.leave_days, row.leave_end, row.companion_leave,
  row.companion_name, row.companion_relation, row.show_diagnosis, row.diagnosis, row.body,
])).digest('hex');

/** The QR code as SVG: pure black modules on a white box (the one place literal colours are right — it is scanned from paper). */
async function qrSvg(url) {
  const raw = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  return raw.replace('<svg ', '<svg role="img" aria-label="QR" ');
}
const verifyUrl = (base, code) => `${String(base).replace(/\/+$/, '')}/verify/${code}`;

// ---------------------------------------------------------------- validation
const flag = () => z.preprocess((v) => (Array.isArray(v) ? v[v.length - 1] : v) === '1' || v === 'on' || v === true || v === 'true', z.boolean());
const time = () => z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a valid time.');

const baseSchema = z.object({
  doc_type: z.enum(TYPES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  language: z.preprocess(emptyToUndefined, z.enum(['ar', 'en']).default('ar')),
  include_national_id: flag(),
  replaces_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
});
const sickSchema = z.object({
  leave_start: isoDate(),
  leave_days: z.preprocess(emptyToUndefined, z.coerce.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(1, 'Too small.').max(MAX_LEAVE_DAYS, 'Too large.').default(1)),
  show_diagnosis: flag(),
  diagnosis: optionalString(500),
  companion_leave: flag(),
  companion_name: optionalString(190),
  companion_relation: optionalString(60),
});
const reportSchema = z.object({
  addressee: optionalString(190),
  findings: optionalString(5000),
  diagnosis: optionalString(1000),
  recommendations: optionalString(5000),
  attachments: optionalString(3000),
});
const attendanceSchema = z.object({ time_from: time(), time_to: time() });

// ---------------------------------------------------------------- serials
/**
 * Claims the next serial number for (clinic, type, year) inside `trx`. The counter row is created up front outside
 * the transaction (INSERT IGNORE), then `UPDATE … + 1` takes the row lock so concurrent issues queue up and every
 * number is used exactly once, in order.
 */
async function ensureCounter(businessId, type, year) {
  await knex.raw('INSERT IGNORE INTO certificate_sequences (business_id, doc_type, year, last_value) VALUES (?, ?, ?, 0)', [businessId, type, year]);
}
async function nextSerial(trx, businessId, type, year) {
  await trx('certificate_sequences').where({ business_id: businessId, doc_type: type, year }).increment('last_value', 1);
  const row = await trx('certificate_sequences').where({ business_id: businessId, doc_type: type, year }).first('last_value');
  return Number(row.last_value);
}

// ---------------------------------------------------------------- reading
function scoped(ctx) {
  const q = knex('certificates as c').where('c.business_id', ctx.businessId);
  if (ctx.ownDoctorId) q.where('c.doctor_id', ctx.ownDoctorId); // a doctor login sees only their own documents
  return q;
}

function parse(row) {
  if (!row) return row;
  let body = row.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return { ...row, body: body || {}, companion_leave: !!row.companion_leave, show_diagnosis: !!row.show_diagnosis };
}

async function get(ctx, id) {
  const row = await scoped(ctx).where('c.id', id).leftJoin('users as u', 'u.id', 'c.issued_by').leftJoin('users as r', 'r.id', 'c.revoked_by')
    .first('c.*', 'u.name as issued_by_name', 'r.name as revoked_by_name');
  if (!row) throw E.notFound('Document');
  return parse(row);
}

async function forVisit(ctx, appointmentId) {
  const rows = await scoped(ctx).where('c.appointment_id', appointmentId).orderBy('c.id', 'desc')
    .select('c.id', 'c.doc_type', 'c.serial', 'c.language', 'c.issued_at', 'c.revoked_at', 'c.leave_start', 'c.leave_end', 'c.leave_days');
  return rows;
}

function applyFilters(q, query = {}) {
  if (TYPES.includes(query.type)) q.where('c.doc_type', query.type);
  if (query.doctor && query.doctor !== 'all' && /^\d+$/.test(String(query.doctor))) q.where('c.doctor_id', Number(query.doctor));
  if (query.patient && /^\d+$/.test(String(query.patient))) q.where('c.patient_id', Number(query.patient));
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.from || '')) q.where('c.issued_at', '>=', `${query.from} 00:00:00`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.to || '')) q.where('c.issued_at', '<=', `${query.to} 23:59:59`);
  if (query.status === 'valid') q.whereNull('c.revoked_at');
  if (query.status === 'revoked') q.whereNotNull('c.revoked_at');
  const s = String(query.q || '').trim();
  if (s) q.where((w) => w.where('c.serial', 'like', `%${s.replace(/[%_]/g, '')}%`).orWhere('c.patient_name', 'like', `%${s.replace(/[%_]/g, '')}%`));
  return q;
}

async function list(ctx, query = {}, { all = false } = {}) {
  const perPage = 25;
  const [{ n }] = await applyFilters(scoped(ctx), query).count({ n: '*' });
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(pages, Math.max(1, Number(query.page) || 1));
  const q = applyFilters(scoped(ctx), query).leftJoin('users as u', 'u.id', 'c.issued_by').orderBy('c.id', 'desc')
    .select('c.id', 'c.doc_type', 'c.serial', 'c.language', 'c.patient_id', 'c.patient_name', 'c.doctor_id', 'c.doctor_name', 'c.doctor_name_en', 'c.appointment_id',
      'c.visit_date', 'c.leave_start', 'c.leave_end', 'c.leave_days', 'c.issued_at', 'c.revoked_at', 'c.revoke_reason', 'u.name as issued_by_name');
  if (!all) q.limit(perPage).offset((page - 1) * perPage);
  return { rows: await q, meta: { page, pages, perPage, total } };
}

// ---------------------------------------------------------------- issuing
/** The visit a document is issued for, with the checks that apply to every type. */
async function visitFor(ctx, appointmentId) {
  if (!ctx.permissions || !ctx.permissions.has('certificates.issue')) throw E.forbidden('certificates.issue');
  const a = await appts.get(ctx, appointmentId); // 404 for another doctor's visit when ownDoctorId is set
  if (a.appointment_type === 'blocked') throw E.notFound('Appointment');
  if (['cancelled', 'no_show'].includes(a.status)) throw new AppError('VISIT_NOT_ATTENDED', 'Documents can be issued only for visits that took place.', 409);
  if (ctx.today && a.appointment_date > ctx.today) throw new AppError('VISIT_IN_FUTURE', 'This visit has not taken place yet.', 409);
  return a;
}

/** Defaults for the issue form (prefilled from the visit and its clinical note). */
async function defaults(ctx, a, business) {
  const [patient, consult] = await Promise.all([
    a.patient_id ? knex('patients').where({ id: a.patient_id, business_id: ctx.businessId }).first('national_id') : null,
    knex('consultations').where({ business_id: ctx.businessId, appointment_id: a.id }).first('diagnosis', 'objective', 'assessment', 'plan_text'),
  ]);
  const tz = (business && business.timezone) || ctx.timezone;
  const from = (a.arrived_at && localTime(tz, a.arrived_at)) || a.appointment_time;
  return {
    language: ctx.locale === 'en' ? 'en' : 'ar',
    nationalId: patient && patient.national_id ? patient.national_id : null,
    include_national_id: patient && patient.national_id ? '1' : '',
    leave_start: a.appointment_date, leave_days: 1, show_diagnosis: '', diagnosis: (consult && consult.diagnosis) || '',
    findings: (consult && [consult.objective, consult.assessment].filter(Boolean).join('\n')) || '', recommendations: (consult && consult.plan_text) || '',
    time_from: from, time_to: addMinutes(from, Math.max(15, Number(a.duration_minutes) || 30)),
  };
}

async function issue(ctx, appointmentId, input, { business } = {}) {
  const a = await visitFor(ctx, appointmentId);
  const base = validate(baseSchema, input);
  const type = base.doc_type;
  const doctorId = a.doctor_id || ctx.doctorId || null;
  if (!doctorId) throw new AppError('NO_DOCTOR', 'Assign a doctor to this visit first.', 409);
  const [doctor, patient] = await Promise.all([
    knex('doctors').where({ id: doctorId, business_id: ctx.businessId }).first('full_name', 'full_name_en', 'specialization', 'specialization_en', 'license_number'),
    a.patient_id ? knex('patients').where({ id: a.patient_id, business_id: ctx.businessId }).first('full_name', 'national_id', 'date_of_birth', 'gender') : null,
  ]);
  if (!doctor) throw new AppError('NO_DOCTOR', 'Assign a doctor to this visit first.', 409);
  const clinic = business || await knex('businesses').where({ id: ctx.businessId }).first('name', 'name_en');

  const row = {
    business_id: ctx.businessId, doc_type: type, language: base.language, appointment_id: a.id, patient_id: a.patient_id || null, doctor_id: doctorId, issued_by: ctx.userId || null,
    patient_name: (patient && patient.full_name) || a.patient_name, patient_national_id: base.include_national_id && patient && patient.national_id ? patient.national_id : null,
    patient_dob: (patient && patient.date_of_birth) || null, patient_gender: (patient && patient.gender) || null,
    doctor_name: doctor.full_name, doctor_name_en: doctor.full_name_en || null, doctor_specialty: doctor.specialization || null, doctor_specialty_en: doctor.specialization_en || null,
    doctor_license: doctor.license_number || null, clinic_name: clinic.name, clinic_name_en: clinic.name_en || null, visit_date: a.appointment_date,
    companion_leave: false, show_diagnosis: false, body: null,
  };

  if (type === 'sick_leave') {
    const d = validate(sickSchema, input);
    const errors = {};
    if (d.leave_start < a.appointment_date) errors.leave_start = 'Choose a valid value.';
    if (d.leave_start > addDays(a.appointment_date, 7)) errors.leave_start = 'Choose a valid value.';
    if (d.show_diagnosis && !d.diagnosis) errors.diagnosis = 'Required.';
    if (d.companion_leave && !d.companion_name) errors.companion_name = 'Required.';
    if (Object.keys(errors).length) throw E.validation(errors);
    Object.assign(row, {
      leave_start: d.leave_start, leave_days: d.leave_days, leave_end: addDays(d.leave_start, d.leave_days - 1),
      show_diagnosis: d.show_diagnosis, diagnosis: d.show_diagnosis ? d.diagnosis : null,
      companion_leave: d.companion_leave, companion_name: d.companion_leave ? d.companion_name : null, companion_relation: d.companion_leave ? d.companion_relation || null : null,
    });
  } else if (type === 'medical_report') {
    const d = validate(reportSchema, input);
    if (!d.findings && !d.diagnosis && !d.recommendations) throw E.validation({ findings: 'Required.' });
    const attachments = String(d.attachments || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_ATTACHMENTS).map((s) => s.slice(0, 190));
    Object.assign(row, {
      show_diagnosis: !!d.diagnosis, diagnosis: d.diagnosis || null,
      body: JSON.stringify({ addressee: d.addressee || null, findings: d.findings || null, recommendations: d.recommendations || null, attachments }),
    });
  } else {
    const d = validate(attendanceSchema, input);
    if (d.time_to <= d.time_from) throw E.validation({ time_to: 'Enter a valid time.' });
    Object.assign(row, { time_from: d.time_from, time_to: d.time_to });
  }

  if (base.replaces_id) {
    const old = await knex('certificates').where({ id: base.replaces_id, business_id: ctx.businessId, appointment_id: a.id }).first('id', 'revoked_at');
    if (!old || !old.revoked_at) throw E.validation({ replaces_id: 'Choose a valid value.' });
    row.replaces_id = old.id;
  }

  const year = Number(String(ctx.today || new Date().toISOString()).slice(0, 4));
  await ensureCounter(ctx.businessId, type, year);
  return knex.transaction(async (trx) => {
    const n = await nextSerial(trx, ctx.businessId, type, year);
    Object.assign(row, { serial: serialOf(type, year, n), serial_year: year, serial_number: n, verify_code: newCode(), issued_at: new Date() });
    row.content_hash = hashOf(row);
    const [id] = await trx('certificates').insert(row);
    await audit.record(ctx, 'certificate.issued', { entityType: 'certificate', entityId: id, newValues: { serial: row.serial, doc_type: type, appointment_id: a.id, patient_id: row.patient_id, doctor_id: doctorId, replaces_id: row.replaces_id || null } }, trx);
    return id;
  });
}

const revokeSchema = z.object({ reason: z.string({ required_error: 'Required.', invalid_type_error: 'Required.' }).trim().min(3, 'Required.').max(500, 'Too large.') });

async function revoke(ctx, id, input) {
  if (!ctx.permissions || !ctx.permissions.has('certificates.issue')) throw E.forbidden('certificates.issue');
  const doc = await get(ctx, id); // scope (clinic + a doctor's own documents)
  const { reason } = validate(revokeSchema, input);
  if (doc.revoked_at) throw new AppError('ALREADY_REVOKED', 'This document is already revoked.', 409);
  return knex.transaction(async (trx) => {
    const n = await trx('certificates').where({ id: doc.id, business_id: ctx.businessId }).whereNull('revoked_at')
      .update({ revoked_at: new Date(), revoked_by: ctx.userId || null, revoke_reason: reason });
    if (!n) throw new AppError('ALREADY_REVOKED', 'This document is already revoked.', 409);
    await audit.record(ctx, 'certificate.revoked', { entityType: 'certificate', entityId: doc.id, oldValues: { serial: doc.serial }, newValues: { serial: doc.serial, reason } }, trx);
    // Links already sent to the patient stop working.
    await trx('share_links').where({ business_id: ctx.businessId, kind: 'certificate', ref_id: doc.id }).whereNull('revoked_at').update({ revoked_at: new Date() });
    return doc;
  });
}

// ---------------------------------------------------------------- public verification
async function byCode(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  return parse(await knex('certificates').where({ verify_code: c }).first());
}
async function bySerialAndCode(serial, code) {
  const s = normalizeSerial(serial);
  const c = normalizeCode(code);
  if (!s || !c) return null;
  return parse(await knex('certificates').where({ verify_code: c, serial: s }).first());
}

/** What the public verification page may show — nothing clinical, no contact details, no ID number. */
function publicView(row, { locale = 'ar' } = {}) {
  const en = locale === 'en';
  return {
    status: row.revoked_at ? 'revoked' : 'valid',
    revokedAt: row.revoked_at || null,
    docType: row.doc_type,
    serial: row.serial,
    issuedAt: row.issued_at,
    doctorName: (en && row.doctor_name_en) || row.doctor_name,
    doctorSpecialty: (en ? row.doctor_specialty_en || row.doctor_specialty : row.doctor_specialty || row.doctor_specialty_en) || null,
    clinicName: (en && row.clinic_name_en) || row.clinic_name,
    patientMasked: maskName(row.patient_name),
    leaveStart: row.doc_type === 'sick_leave' ? row.leave_start : null,
    leaveEnd: row.doc_type === 'sick_leave' ? row.leave_end : null,
    leaveDays: row.doc_type === 'sick_leave' ? row.leave_days : null,
    visitDate: row.doc_type === 'attendance' ? row.visit_date : null,
  };
}

module.exports = {
  TYPES, PREFIX, MAX_LEAVE_DAYS, newCode, normalizeCode, normalizeSerial, formatCode, serialOf, addDays, maskName, qrSvg, verifyUrl, hashOf,
  get, forVisit, list, applyFilters, visitFor, defaults, issue, revoke, byCode, bySerialAndCode, publicView,
};
