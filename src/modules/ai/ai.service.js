// AI clinical assistant ("second opinion") for doctors, powered by Claude through the official Anthropic SDK.
//
//  • Platform (platform_settings key "ai"): switch, API key (AES-GCM with APP_KEY via core/secrets), model id,
//    monthly request cap per clinic, per-user hourly limit and the data-processing notice shown to clinics.
//  • Clinic (ai_clinic_settings): opt-in (off by default) with an explicit acknowledgement, allowed roles.
//  • Visit actions: summary | second_opinion | rx_check. The input is built server-side from the saved visit and
//    de-identified (no name, phone, national ID, address, exact date of birth, clinic or doctor names; phone
//    numbers, e-mails and links are stripped from free text). The very same text is shown to the doctor before sending.
//  • Output: structured JSON (output_config.format json_schema), language = the user's UI language.
//  • Every request is saved in ai_requests (tokens, status, result) and audited without clinical text.
//
// The SDK client is injectable everywhere (`{ client }`) so tests use a fake object with beta.messages.create.
const { Anthropic } = require('@anthropic-ai/sdk');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { AppError, E } = require('../../core/errors');
const appts = require('../clinic/appointments.service');
const clinical = require('../clinic/clinical.service');

const DEFAULT_MODEL = 'claude-opus-5-5';
const KINDS = ['summary', 'second_opinion', 'rx_check'];
const DEFAULTS = { enabled: false, model: DEFAULT_MODEL, monthly_cap: 300, hourly_limit: 20, notice_ar: '', notice_en: '', api_key_enc: null };
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'; // pairs with the scalar form fallbacks: "default"
const MODEL_RE = /^[a-z0-9][a-z0-9.:@_-]{2,79}$/i;

const fail = (code, status, message) => new AppError(code, message || code, status);

// ---------------------------------------------------------------- platform settings
async function platformSettings() {
  return cache.remember('ai:platform', async () => {
    const row = await knex('platform_settings').where({ key: 'ai' }).first('value');
    let v = {};
    try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
    const s = { ...DEFAULTS, ...v };
    const key = s.api_key_enc ? secrets.decrypt(s.api_key_enc) : null;
    return {
      ...s,
      monthly_cap: Number(s.monthly_cap) || 0,
      hourly_limit: Number(s.hourly_limit) || DEFAULTS.hourly_limit,
      hasKey: Boolean(key),
      keyUnreadable: Boolean(s.api_key_enc && !key),
      keyHint: key ? `•••• ${String(key).slice(-4)}` : null,
      active: Boolean(s.enabled && key),
    };
  }, 30_000);
}
const apiKey = (s) => (s && s.api_key_enc ? secrets.decrypt(s.api_key_enc) : null);
const forget = () => cache.forgetPrefix('ai:');

async function savePlatform(ctx, body) {
  const cur = await platformSettings();
  const errors = {};
  const key = String(body.api_key || '').trim();
  const removeKey = body.remove_key === '1';
  const model = String(body.model || '').trim() || DEFAULT_MODEL;
  const cap = String(body.monthly_cap ?? '').trim() === '' ? DEFAULTS.monthly_cap : Number(body.monthly_cap);
  const hourly = String(body.hourly_limit ?? '').trim() === '' ? DEFAULTS.hourly_limit : Number(body.hourly_limit);
  const on = body.enabled === '1' || body.enabled === 'on';
  const noticeAr = String(body.notice_ar || '').trim();
  const noticeEn = String(body.notice_en || '').trim();
  if (key && (key.length < 20 || key.length > 300 || /\s/.test(key))) errors.api_key = 'Paste the API key exactly as the Claude Console shows it.';
  if (!MODEL_RE.test(model)) errors.model = 'Enter a valid model id, e.g. claude-opus-5-5.';
  if (!Number.isInteger(cap) || cap < 0 || cap > 1_000_000) errors.monthly_cap = 'Enter a whole number between 0 and 1000000.';
  if (!Number.isInteger(hourly) || hourly < 1 || hourly > 1000) errors.hourly_limit = 'Enter a whole number between 1 and 1000.';
  if (noticeAr.length > 3000) errors.notice_ar = 'Keep it under 3000 characters.';
  if (noticeEn.length > 3000) errors.notice_en = 'Keep it under 3000 characters.';
  if (on && !key && (removeKey || !cur.hasKey)) errors.api_key = 'Enter the API key to turn the assistant on.';
  if (Object.keys(errors).length) throw E.validation(errors);
  let keyEnc = removeKey ? null : cur.api_key_enc;
  if (key) {
    try { keyEnc = secrets.encrypt(key); } catch { throw fail('SECRETS_KEY', 409, 'Set APP_KEY (or SESSION_SECRET) in the server environment to store credentials.'); }
  }
  const next = { enabled: on, model, monthly_cap: cap, hourly_limit: hourly, notice_ar: noticeAr, notice_en: noticeEn, api_key_enc: keyEnc };
  const value = JSON.stringify(next);
  await knex('platform_settings').insert({ key: 'ai', value }).onConflict('key').merge({ value, updated_at: new Date() });
  forget();
  await audit.record(ctx, 'platform.ai_updated', {
    entityType: 'platform', entityId: 'ai',
    oldValues: { enabled: cur.enabled, model: cur.model, monthly_cap: cur.monthly_cap, hourly_limit: cur.hourly_limit },
    newValues: { enabled: on, model, monthly_cap: cap, hourly_limit: hourly, api_key: key ? 'changed' : (keyEnc ? 'kept' : 'removed') },
  });
  return next;
}

// ---------------------------------------------------------------- clinic settings
const parseRoles = (v) => { try { const r = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(r) ? r.map(String) : null; } catch { return null; } };

async function clinicSettings(businessId) {
  const row = await knex('ai_clinic_settings').where({ business_id: businessId }).first();
  return {
    enabled: Boolean(row && row.enabled),
    allowed_roles: (row && parseRoles(row.allowed_roles)) || ['doctor'],
    acknowledged_at: row ? row.acknowledged_at : null,
    acknowledged_by: row ? row.acknowledged_by : null,
    exists: Boolean(row),
  };
}

async function saveClinic(ctx, body, roles) {
  const cur = await clinicSettings(ctx.businessId);
  const on = body.enabled === '1';
  const ack = body.acknowledge === '1';
  const valid = new Set(roles.map((r) => r.key));
  const picked = [].concat(body.roles || []).map(String).filter((k) => valid.has(k));
  const errors = {};
  const needsAck = on && (!cur.enabled || !cur.acknowledged_at);
  if (needsAck && !ack) errors.acknowledge = 'Confirm that you have read the data-processing notice.';
  if (on && !picked.length) errors.roles = 'Choose at least one role.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const allowed = picked.length ? picked : cur.allowed_roles;
  const patch = {
    enabled: on, allowed_roles: JSON.stringify(allowed), updated_at: new Date(),
    ...(needsAck ? { acknowledged_at: new Date(), acknowledged_by: ctx.userId } : {}),
  };
  if (cur.exists) await knex('ai_clinic_settings').where({ business_id: ctx.businessId }).update(patch);
  else await knex('ai_clinic_settings').insert({ business_id: ctx.businessId, ...patch });
  await audit.record(ctx, 'ai.settings_updated', {
    entityType: 'ai_settings', entityId: ctx.businessId,
    oldValues: { enabled: cur.enabled, allowed_roles: cur.allowed_roles.join(',') },
    newValues: { enabled: on, allowed_roles: allowed.join(','), ...(needsAck ? { acknowledged: true } : {}) },
  });
}

// ---------------------------------------------------------------- access & limits (pure)
/** null when the user may use the assistant, else an error code. */
function accessCheck({ platform, clinic, roleKey, permissions }) {
  if (!platform || !platform.enabled) return 'AI_PLATFORM_OFF';
  if (!platform.hasKey) return 'AI_NOT_CONFIGURED';
  if (!clinic || !clinic.enabled) return 'AI_CLINIC_OFF';
  if (!permissions || !permissions.has('clinical.view')) return 'AI_NO_PERMISSION';
  if (!roleKey || !(clinic.allowed_roles || []).includes(roleKey)) return 'AI_ROLE_NOT_ALLOWED';
  return null;
}

/** null when a new request fits the limits, else an error code. cap 0 = no monthly cap. */
function limitCheck({ monthCount, cap, hourCount, hourly }) {
  if (cap > 0 && monthCount >= cap) return 'AI_MONTHLY_CAP';
  if (hourly > 0 && hourCount >= hourly) return 'AI_HOURLY_LIMIT';
  return null;
}

/** The UTC instant at which the clinic's current month started (clinic time zone). */
function monthStart(timezone, now = new Date()) {
  const tz = timezone || 'UTC';
  const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const p = parts(now);
  const guess = Date.UTC(Number(p.year), Number(p.month) - 1, 1);
  const q = parts(new Date(guess));
  const local = Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day), q.hour === '24' ? 0 : Number(q.hour), Number(q.minute), Number(q.second));
  return new Date(guess - (local - guess));
}

const BILLED = ['ok', 'refused', 'truncated'];
async function usage(businessId, timezone) {
  const since = monthStart(timezone);
  const rows = await knex('ai_requests').where({ business_id: businessId }).where('created_at', '>=', since).whereIn('status', BILLED)
    .groupBy('kind').select('kind').count({ n: '*' }).sum({ tin: 'input_tokens', tout: 'output_tokens' });
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]));
  let total = 0; let tin = 0; let tout = 0;
  rows.forEach((r) => { byKind[r.kind] = Number(r.n); total += Number(r.n); tin += Number(r.tin || 0); tout += Number(r.tout || 0); });
  return { total, byKind, inputTokens: tin, outputTokens: tout, since };
}

async function counts(ctx) {
  const since = monthStart(ctx.timezone);
  const hourAgo = new Date(Date.now() - 3_600_000);
  const [[{ m }], [{ h }]] = await Promise.all([
    knex('ai_requests').where({ business_id: ctx.businessId }).where('created_at', '>=', since).whereIn('status', [...BILLED, 'pending']).count({ m: '*' }),
    knex('ai_requests').where({ user_id: ctx.userId }).where('created_at', '>=', hourAgo).count({ h: '*' }),
  ]);
  return { monthCount: Number(m), hourCount: Number(h) };
}

// ---------------------------------------------------------------- de-identification
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const NUMBER_RUN_RE = /(?:\+|00)?\d[\d\s().-]{5,}\d/g;
const DATE_LIKE = /^\d{4}[-.]\d{1,2}[-.]\d{1,2}$|^\d{1,2}[-.]\d{1,2}[-.]\d{2,4}$/;
const NAME_STOP = new Set(['عبد', 'ابو', 'أبو', 'بن', 'ابن', 'بنت', 'آل', 'ال', 'al', 'el', 'bin', 'abu', 'abd', 'dr', 'د', 'mr', 'mrs', 'ms', 'عيادة', 'مركز', 'clinic', 'center', 'centre', 'medical', 'طبي', 'الطبي', 'الطبية', 'دكتور', 'الدكتور', 'doctor']);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Phrases (full names first, then name parts of ≥ 3 letters) that must not leave the clinic. */
function namePhrases({ people = [], orgs = [] } = {}) {
  const full = [...people, ...orgs].map((s) => String(s || '').trim()).filter((s) => s.length >= 2);
  const parts = people.flatMap((s) => String(s || '').split(/[\s.,،\-/]+/)).map((s) => s.trim())
    .filter((s) => s.length >= 3 && !NAME_STOP.has(s.toLowerCase()));
  return [...new Set([...full, ...parts])].sort((a, b) => b.length - a.length);
}

/** Removes contact details and the given names from free text. */
function scrubText(text, phrases = [], extraDates = []) {
  let s = String(text || '');
  if (!s.trim()) return '';
  s = s.replace(EMAIL_RE, '[email]').replace(URL_RE, '[link]');
  extraDates.filter(Boolean).forEach((d) => { s = s.split(d).join('[date]'); });
  s = s.replace(NUMBER_RUN_RE, (m) => {
    const digits = m.replace(/\D/g, '').length;
    if (DATE_LIKE.test(m.trim())) return m;
    return digits >= 7 ? '[number]' : m;
  });
  phrases.forEach((p) => { s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escRe(p)}(?![\\p{L}\\p{N}])`, 'giu'), '[name]'); });
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** "34 years" / "18 months" / "3 weeks" from a date of birth on the clinic's today. */
function ageLabel(dob, today) {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(String(dob)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(today))) return null;
  const [y, m, d] = String(dob).split('-').map(Number);
  const [ty, tm, td] = String(today).split('-').map(Number);
  let months = (ty - y) * 12 + (tm - m);
  if (td < d) months -= 1;
  if (months < 0) return null;
  if (months >= 24) return `${Math.floor(months / 12)} years`;
  if (months >= 1) return `${months} months`;
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86_400_000);
  return days >= 0 ? `${Math.max(0, Math.floor(days / 7))} weeks` : null;
}

const monthsBetween = (from, to) => {
  if (!/^\d{4}-\d{2}/.test(String(from)) || !/^\d{4}-\d{2}/.test(String(to))) return null;
  const [y1, m1] = String(from).split('-').map(Number); const [y2, m2] = String(to).split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
};

const VITAL_FORMAT = [
  ['weightKg', 'weight', ' kg'], ['heightCm', 'height', ' cm'], ['temperatureC', 'temperature', ' °C'], ['pulseBpm', 'pulse', ' bpm'],
  ['spo2', 'SpO2', '%'], ['bloodPressure', 'blood pressure', ' mmHg'], ['respiratoryRate', 'respiratory rate', '/min'], ['bloodSugar', 'blood sugar', ' mg/dL'],
];
const SEX = { male: 'male', female: 'female', m: 'male', f: 'female' };

/**
 * Pure: turns visit data into the de-identified text sent to the model.
 * @param {object} d { kind, patient, appointment, consult, prescriptions, history, doctorNames, clinicNames, today }
 */
function composeInput(d) {
  const p = d.patient || {};
  const c = d.consult || {};
  const v = (c.vital_signs && typeof c.vital_signs === 'object') ? c.vital_signs : {};
  const phrases = namePhrases({ people: [p.full_name, d.appointment && d.appointment.patient_name, ...(d.doctorNames || [])], orgs: d.clinicNames || [] });
  const dobForms = p.date_of_birth ? [p.date_of_birth, String(p.date_of_birth).split('-').reverse().join('/'), String(p.date_of_birth).split('-').reverse().join('-')] : [];
  const clean = (s) => scrubText(s, phrases, dobForms);
  const lines = [];
  const add = (label, value) => { const s = clean(value); if (s) lines.push(`${label}: ${s.includes('\n') ? `\n${s}` : s}`); };

  const who = [SEX[String(p.gender || '').toLowerCase()] || 'sex not recorded', ageLabel(p.date_of_birth, d.today) || 'age not recorded'];
  lines.push(`Patient: ${who.join(', ')}`);
  add('Known allergies', p.allergies || 'none recorded');
  add('Chronic conditions', p.chronic_conditions || 'none recorded');

  const vit = VITAL_FORMAT.filter(([k]) => v[k] !== undefined && v[k] !== null && String(v[k]).trim() !== '').map(([k, label, unit]) => `${label} ${String(v[k]).trim()}${unit}`);
  const w = Number(v.weightKg); const h = Number(v.heightCm) / 100;
  if (w > 0 && h > 0) vit.push(`BMI ${Math.round((w / (h * h)) * 10) / 10}`);
  if (vit.length) lines.push(`Vital signs: ${vit.join('; ')}`);
  else lines.push('Vital signs: not recorded');

  add('Working diagnosis', c.diagnosis);
  if (d.kind !== 'rx_check') {
    add('Subjective', c.subjective);
    add('Objective', c.objective);
    add('Assessment', c.assessment);
    add('Plan', c.plan_text);
  }

  const items = (d.prescriptions || []).flatMap((rx) => (Array.isArray(rx.items) ? rx.items : []));
  if (items.length) {
    lines.push('Prescription (this visit):');
    items.forEach((it, i) => {
      const parts = [it.medicationName, it.dosage, it.frequency, it.duration, it.instructions].map((x) => clean(x)).filter(Boolean);
      if (parts.length) lines.push(`${i + 1}. ${parts.join(' — ')}`);
    });
  } else {
    lines.push('Prescription (this visit): none');
  }

  if (d.kind !== 'rx_check' && d.history && d.history.length) {
    const prev = d.history.map((hh) => {
      const text = clean(hh.diagnosis || hh.assessment);
      if (!text) return null;
      const mo = monthsBetween(hh.appointment_date, d.today);
      const when = mo === null ? 'earlier' : mo <= 0 ? 'this month' : mo === 1 ? '1 month earlier' : `${mo} months earlier`;
      return `- ${when}: ${text}`;
    }).filter(Boolean);
    if (prev.length) { lines.push('Previous visits (most recent first):'); lines.push(...prev); }
  }
  return lines.join('\n');
}

/** True when there is something clinically useful to send for this action. */
function hasContent(kind, d) {
  const c = d.consult || {};
  const items = (d.prescriptions || []).flatMap((rx) => (Array.isArray(rx.items) ? rx.items : []));
  if (kind === 'rx_check') return items.length > 0;
  const note = [c.diagnosis, c.subjective, c.objective, c.assessment, c.plan_text].some((x) => String(x || '').trim());
  const vit = c.vital_signs && Object.keys(c.vital_signs).length > 0;
  return note || (kind === 'summary' && (vit || items.length > 0));
}

/** Loads the saved visit (doctor scope enforced by appointments.service) and returns { text, ok }. */
async function visitData(ctx, apptId) {
  const a = await appts.get(ctx, Number(apptId));
  if (a.appointment_type === 'blocked') throw E.notFound('Appointment');
  const [patient, consult, prescriptions, history, doctors, business] = await Promise.all([
    a.patient_id ? knex('patients').where({ business_id: ctx.businessId, id: a.patient_id }).first('full_name', 'date_of_birth', 'gender', 'allergies', 'chronic_conditions') : null,
    clinical.consultation(ctx, a.id),
    clinical.prescriptionsFor(ctx, a.id),
    a.patient_id
      ? knex('consultations as c').join('appointments as ap', 'ap.id', 'c.appointment_id')
        .where({ 'c.business_id': ctx.businessId, 'c.patient_id': a.patient_id }).whereNot('c.appointment_id', a.id)
        .where('ap.appointment_date', '<=', a.appointment_date)
        .modify((q) => { if (ctx.ownDoctorId) q.where('ap.doctor_id', ctx.ownDoctorId); })
        .orderBy('ap.appointment_date', 'desc').limit(5).select('c.diagnosis', 'c.assessment', 'ap.appointment_date')
      : [],
    knex('doctors').where({ business_id: ctx.businessId }).select('full_name', 'full_name_en'),
    knex('businesses').where({ id: ctx.businessId }).first('name', 'name_en'),
  ]);
  return {
    a, patient: patient || { full_name: a.patient_name }, appointment: a, consult, prescriptions, history,
    doctorNames: doctors.flatMap((x) => [x.full_name, x.full_name_en]).filter(Boolean),
    clinicNames: [business && business.name, business && business.name_en].filter(Boolean),
    today: ctx.today || new Date().toISOString().slice(0, 10),
  };
}

async function buildInput(ctx, apptId, kind) {
  const d = await visitData(ctx, apptId);
  return { a: d.a, text: composeInput({ ...d, kind }), ok: hasContent(kind, d) };
}

// ---------------------------------------------------------------- prompts & schemas
const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });

const SCHEMAS = {
  summary: obj({
    chief_complaint: str,
    key_findings: strArr,
    assessment: str,
    plan: strArr,
    medications: strArr,
    follow_up: str,
    summary_text: str,
  }),
  second_opinion: obj({
    differentials: { type: 'array', items: obj({ diagnosis: str, likelihood: { type: 'string', enum: ['high', 'moderate', 'low'] }, reasoning: str }) },
    red_flags: strArr,
    investigations: { type: 'array', items: obj({ test: str, reason: str }) },
    questions: strArr,
    missing_information: strArr,
  }),
  rx_check: obj({
    overall: { type: 'string', enum: ['no_concerns', 'review', 'serious'] },
    interactions: { type: 'array', items: obj({ drugs: str, severity: { type: 'string', enum: ['minor', 'moderate', 'major'] }, explanation: str, suggestion: str }) },
    dose_concerns: { type: 'array', items: obj({ drug: str, concern: str, suggestion: str }) },
    allergy_concerns: { type: 'array', items: obj({ drug: str, allergy: str, concern: str }) },
    condition_concerns: { type: 'array', items: obj({ drug: str, condition: str, concern: str }) },
    notes: str,
  }),
};

const TASKS = {
  summary: 'Write a concise, structured clinical summary of this visit suitable for the patient file or as the basis of a referral letter. '
    + '"summary_text" is one short paragraph (3-6 sentences) the physician can paste into the note. Use only facts present in the input; leave a field empty ("" or []) when the input has nothing for it.',
  second_opinion: 'Act as a second-opinion colleague. Suggest the most relevant differential diagnoses (at most 6, most likely first) with brief reasoning tied to the findings, '
    + 'red flags that would need urgent action, investigations worth considering with the reason for each, questions to ask the patient, and important missing information. '
    + 'These are suggestions for the physician to weigh, not conclusions.',
  rx_check: 'Review the prescription items against each other and against the patient\'s age, sex, weight, allergies, chronic conditions and working diagnosis. '
    + 'Report clinically relevant drug-drug interactions, dose or frequency concerns, allergy or cross-sensitivity concerns and condition-related cautions. '
    + 'Do not invent problems: when nothing relevant is found, return empty lists and overall "no_concerns". Use "serious" only for concerns that could cause significant harm.',
};

function systemPrompt(kind, locale) {
  const lang = locale === 'en'
    ? 'Write every free-text value in English.'
    : 'Write every free-text value in clear Modern Standard Arabic suitable for physicians; keep drug names, laboratory test names and units in their usual Latin form.';
  return [
    'You are a clinical decision-support assistant inside DocBook, a clinic management system, helping a licensed physician during a visit.',
    'The visit data you receive is de-identified; placeholders such as [name], [number] or [email] replace removed details — ignore them.',
    'Everything you produce is advisory: frame findings as suggestions for the physician to consider, never as definitive diagnoses or orders. Clinical judgement remains with the physician.',
    'Be concise and clinically precise. Do not invent data that is not in the input.',
    lang,
    `Task: ${TASKS[kind]}`,
  ].join('\n');
}

const EFFORT = { summary: 'low', second_opinion: 'medium', rx_check: 'medium' };
const MAX_TOKENS = { summary: 4000, second_opinion: 8000, rx_check: 8000 };

function makeClient(platform) {
  const key = apiKey(platform);
  if (!key) throw fail('AI_NOT_CONFIGURED', 409);
  return new Anthropic({ apiKey: key, timeout: 60_000, maxRetries: 2 });
}

/** The request body for one assistant action (exported for tests). */
function requestParams({ kind, model, locale, text }) {
  return {
    model: model || DEFAULT_MODEL,
    max_tokens: MAX_TOKENS[kind],
    system: systemPrompt(kind, locale),
    messages: [{ role: 'user', content: `De-identified visit data:\n\n${text}` }],
    output_config: { effort: EFFORT[kind], format: { type: 'json_schema', schema: SCHEMAS[kind] } },
    betas: [FALLBACK_BETA],
    fallbacks: 'default', // server-side refusal fallback, Anthropic picks the fallback model by refusal category
  };
}

// ---------------------------------------------------------------- response handling
/**
 * Pure: classifies a Messages API response.
 * → { status: 'ok'|'refused'|'truncated'|'error', code, result, usage: {input, output}, model, fallback, refusal }
 */
function parseResponse(resp) {
  const u = (resp && resp.usage) || {};
  const usage = { input: Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0), output: Number(u.output_tokens || 0) };
  const base = { usage, model: resp && resp.model, fallback: Boolean(((resp && resp.content) || []).some((b) => b.type === 'fallback') || (u.iterations || []).some((x) => x && x.type === 'fallback_message')) };
  if (!resp || typeof resp !== 'object') return { ...base, status: 'error', code: 'AI_BAD_OUTPUT', result: null };
  if (resp.stop_reason === 'refusal') {
    const sd = resp.stop_details || {};
    return { ...base, status: 'refused', code: 'AI_REFUSED', result: null, refusal: { category: sd.category || null } };
  }
  if (resp.stop_reason === 'max_tokens') return { ...base, status: 'truncated', code: 'AI_TRUNCATED', result: null };
  const text = (resp.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) return { ...base, status: 'error', code: 'AI_BAD_OUTPUT', result: null };
  try {
    const result = JSON.parse(text);
    if (!result || typeof result !== 'object' || Array.isArray(result)) return { ...base, status: 'error', code: 'AI_BAD_OUTPUT', result: null };
    return { ...base, status: 'ok', code: null, result };
  } catch {
    return { ...base, status: 'error', code: 'AI_BAD_OUTPUT', result: null };
  }
}

/** Maps SDK errors (typed classes, most specific first) to our error codes. */
function errorCode(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'AI_AUTH';
  if (err instanceof Anthropic.PermissionDeniedError) return 'AI_FORBIDDEN';
  if (err instanceof Anthropic.NotFoundError) return 'AI_MODEL_NOT_FOUND';
  if (err instanceof Anthropic.RateLimitError) return 'AI_PROVIDER_RATE_LIMIT';
  if (err instanceof Anthropic.BadRequestError) return 'AI_BAD_REQUEST';
  if (err instanceof Anthropic.InternalServerError) return 'AI_PROVIDER_DOWN';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'AI_TIMEOUT';
  if (err instanceof Anthropic.APIConnectionError) return 'AI_NETWORK';
  if (err instanceof Anthropic.APIError) return Number(err.status) === 529 ? 'AI_PROVIDER_DOWN' : 'AI_API_ERROR';
  if (err instanceof AppError) return err.code;
  return 'AI_API_ERROR';
}
const httpFor = (code) => ({ AI_PLATFORM_OFF: 403, AI_NOT_CONFIGURED: 403, AI_CLINIC_OFF: 403, AI_NO_PERMISSION: 403, AI_ROLE_NOT_ALLOWED: 403, AI_MONTHLY_CAP: 429, AI_HOURLY_LIMIT: 429, AI_NOTHING_TO_SEND: 422, AI_REFUSED: 422, AI_TRUNCATED: 422, AI_BAD_OUTPUT: 502 }[code] || 502);

// ---------------------------------------------------------------- the action
async function access(ctx) {
  const [platform, clinic] = await Promise.all([platformSettings(), clinicSettings(ctx.businessId)]);
  return { platform, clinic, code: accessCheck({ platform, clinic, roleKey: ctx.roleKey, permissions: ctx.permissions }) };
}

/**
 * Runs one assistant action on a visit. Throws AppError(code) for every refusal to run or failure.
 * @returns {Promise<{ id, kind, result, model, created_at }>}
 */
async function run(ctx, apptId, kind, { client, locale } = {}) {
  if (!KINDS.includes(kind)) throw E.notFound('Action');
  const { platform, code: denied } = await access(ctx);
  if (denied) throw fail(denied, httpFor(denied));
  const input = await buildInput(ctx, apptId, kind); // NOT_FOUND outside the doctor's scope
  if (!input.ok) throw fail('AI_NOTHING_TO_SEND', 422);
  const lim = limitCheck({ ...(await counts(ctx)), cap: platform.monthly_cap, hourly: platform.hourly_limit });
  const lang = locale === 'en' ? 'en' : 'ar';
  if (lim) {
    await audit.record(ctx, 'ai.request_blocked', { entityType: 'appointment', entityId: input.a.id, newValues: { kind, reason: lim } });
    throw fail(lim, 429);
  }
  const [id] = await knex('ai_requests').insert({ business_id: ctx.businessId, user_id: ctx.userId, appointment_id: input.a.id, kind, model: platform.model, locale: lang, status: 'pending' });
  const finish = async (patch) => {
    await knex('ai_requests').where({ id }).update(patch);
    await audit.record(ctx, 'ai.request', {
      entityType: 'appointment', entityId: input.a.id,
      newValues: { request_id: id, kind, status: patch.status, model: patch.model || platform.model, input_tokens: patch.input_tokens || 0, output_tokens: patch.output_tokens || 0, error_code: patch.error_code || null },
    });
  };
  let resp;
  try {
    const c = client || makeClient(platform);
    resp = await c.beta.messages.create(requestParams({ kind, model: platform.model, locale: lang, text: input.text }));
  } catch (err) {
    const code = errorCode(err);
    await finish({ status: 'error', error_code: code });
    throw fail(code, httpFor(code), err && err.message);
  }
  const r = parseResponse(resp);
  await finish({
    status: r.status, error_code: r.code, model: r.model || platform.model, input_tokens: r.usage.input, output_tokens: r.usage.output,
    result: r.status === 'ok' ? JSON.stringify({ ...r.result, _meta: { fallback: r.fallback } }) : (r.refusal ? JSON.stringify({ _refusal: r.refusal }) : null),
  });
  if (r.status !== 'ok') throw fail(r.code, httpFor(r.code));
  return { id, kind, result: r.result, model: r.model || platform.model, created_at: new Date() };
}

/** Latest successful result per action for a visit (the caller has already checked visit access). */
async function lastResults(ctx, apptId) {
  const rows = await knex('ai_requests as r').leftJoin('users as u', 'u.id', 'r.user_id')
    .where({ 'r.business_id': ctx.businessId, 'r.appointment_id': apptId, 'r.status': 'ok' })
    .orderBy('r.id', 'desc').limit(30).select('r.id', 'r.kind', 'r.model', 'r.result', 'r.created_at', 'u.name as user_name');
  const out = {};
  rows.forEach((row) => {
    if (out[row.kind]) return;
    let result = null;
    try { result = JSON.parse(row.result); } catch { result = null; }
    if (result) out[row.kind] = { id: row.id, kind: row.kind, model: row.model, created_at: row.created_at, user_name: row.user_name, result };
  });
  return out;
}

/** One tiny request to check the key and model. → { ok, code, model, message } */
async function testConnection(platform, { client } = {}) {
  try {
    const c = client || makeClient(platform);
    const resp = await c.beta.messages.create({
      model: platform.model || DEFAULT_MODEL, max_tokens: 256, output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }], betas: [FALLBACK_BETA], fallbacks: 'default',
    });
    return { ok: true, model: resp && resp.model, stop: resp && resp.stop_reason };
  } catch (err) {
    return { ok: false, code: errorCode(err), message: err && err.message ? String(err.message).slice(0, 300) : '' };
  }
}

// ---------------------------------------------------------------- form runner
/**
 * Like settings/form, but validation messages come from errors_ai.vmsg and codes from errors_ai.<CODE>
 * (the shared runners would turn our English messages into a generic "invalid value").
 */
function formRunner(action, rerender) {
  const { dictionaries } = require('../../core/i18n'); // eslint-disable-line global-require
  const { codeText } = require('../settings/form'); // eslint-disable-line global-require
  return (req, res, next) => Promise.resolve().then(() => action(req, res, next)).catch((err) => {
    if (!(err instanceof AppError) || ![409, 422].includes(err.status)) return next(err);
    const own = ((dictionaries[req.locale] || {}).errors_ai || {});
    res.status(err.status);
    return Promise.resolve(rerender(req, res, {
      errors: err.code === 'VALIDATION_FAILED' && err.details ? Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k, (own.vmsg || {})[v] || v])) : {},
      formError: { code: err.code, message: own[err.code] || codeText(req, err), details: err.details },
      old: req.body,
    })).catch(next);
  });
}

module.exports = {
  formRunner, DEFAULT_MODEL, KINDS, SCHEMAS, FALLBACK_BETA,
  platformSettings, savePlatform, forget, clinicSettings, saveClinic,
  accessCheck, limitCheck, monthStart, usage, counts, access,
  namePhrases, scrubText, ageLabel, composeInput, hasContent, visitData, buildInput,
  systemPrompt, requestParams, parseResponse, errorCode, httpFor, makeClient,
  run, lastResults, testConnection,
};
