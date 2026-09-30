// ICD-10 diagnosis codes: the bundled WHO ICD-10 subset (icd10.json — source and licence inside the file), the
// clinic's own custom codes, search with the clinic's most-used codes first, and the coded diagnoses of a visit.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, optionalString } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const DATA = require('./icd10.json');

// ---------------------------------------------------------------- text normalisation (Arabic + English)
const AR_DIACRITICS = /[ً-ْٰـ]/g; // tashkeel, superscript alef, tatweel
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[،؛؟.,;:()[\]"'’`/\\-]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
// Arabic words often carry the article "ال" or a leading "و"/"ب"/"ل" — index both forms so "التهاب" and "التهابات" match.
const wordForms = (w) => { const out = [w]; if (/^(ال|وال|بال|لل)/.test(w) && w.length > 4) out.push(w.replace(/^(ال|وال|بال|لل)/, '')); return out; };

/** Canonical form of a code typed by hand: "j069" → "J06.9", "i10" → "I10". */
function normalizeCode(input) {
  const s = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z]\d{2})\.?(\d{1,2})?$/.exec(s);
  if (m) return m[2] ? `${m[1]}.${m[2]}` : m[1];
  return s;
}
const keyOf = (code) => String(code).toUpperCase().replace(/[.\s]/g, '');

const INDEX = DATA.codes.map(([code, en, ar, kw]) => {
  const text = norm(`${en} ${ar} ${kw || ''}`);
  const words = [...new Set(text.split(' ').flatMap(wordForms))];
  const kws = kw ? kw.split(';').map(norm).filter(Boolean) : [];
  return { code, en, ar, key: keyOf(code), enN: norm(en), arN: norm(ar), words, kws, custom: false };
});
const BY_CODE = new Map(INDEX.map((e) => [e.code, e]));

function customEntry(r) {
  const text = norm(`${r.title_ar} ${r.title_en || ''}`);
  return { code: r.code, en: r.title_en || r.title_ar, ar: r.title_ar, key: keyOf(r.code), enN: norm(r.title_en || ''), arN: norm(r.title_ar), words: [...new Set(text.split(' ').flatMap(wordForms))], kws: [], custom: true, id: r.id };
}
const activeCustom = (businessId) => knex('icd_custom_codes').where({ business_id: businessId, is_active: true }).select('id', 'code', 'title_ar', 'title_en');

/** How often each code was used by this clinic (all time). */
async function usage(businessId) {
  const rows = await knex('consultation_diagnoses').where({ business_id: businessId }).groupBy('code').select('code').count({ n: '*' });
  return new Map(rows.map((r) => [r.code, Number(r.n)]));
}

/**
 * Pure ranking used by search(): an exact code first, then the clinic's most-used codes, then match quality
 * (code prefix, title starting with the query, every word matched), then code order.
 */
function rank(entries, q, uses = new Map(), limit = 20) {
  const qn = norm(q);
  if (qn.replace(/\s/g, '').length < 2) return [];
  const qk = keyOf(q);
  const codeLike = /^[A-Z]\d/.test(qk);
  const tokens = qn.split(' ').filter(Boolean);
  const out = [];
  for (const e of entries) {
    let score = 0;
    if (codeLike && e.key === qk) score = 1000;
    else if (codeLike && e.key.startsWith(qk)) score = 600 - (e.key.length - qk.length) * 10;
    else if (!codeLike && e.key.startsWith(qk)) score = 550; // custom codes like "DENT-01"
    else {
      const all = tokens.every((tk) => e.words.some((w) => w.startsWith(tk)));
      if (!all) continue; // eslint-disable-line no-continue
      score = 200;
      if (e.enN.startsWith(qn) || e.arN.startsWith(qn)) score += 100;
      if (e.kws.includes(qn)) score += 120; else if (e.kws.some((k) => k.startsWith(qn))) score += 60; // common names ("سكري", "tonsillitis")
      score += tokens.filter((tk) => e.words.includes(tk)).length * 10; // whole-word hits
      score -= Math.min(40, Math.floor((e.en.length + e.ar.length) / 20)); // shorter, more general titles first
    }
    out.push({ e, score, uses: uses.get(e.code) || 0 });
  }
  out.sort((a, b) => (b.score >= 1000) - (a.score >= 1000) || b.uses - a.uses || b.score - a.score || a.e.code.localeCompare(b.e.code));
  return out.slice(0, limit).map(({ e, uses: n }) => ({ code: e.code, title_ar: e.ar, title_en: e.en, custom: e.custom, uses: n }));
}

async function search(businessId, q, { limit = 20 } = {}) {
  if (norm(q).replace(/\s/g, '').length < 2) return [];
  const [custom, uses] = await Promise.all([activeCustom(businessId), usage(businessId)]);
  return rank([...custom.map(customEntry), ...INDEX], q, uses, limit);
}

/** A code from the bundled list or the clinic's active custom codes, or null. */
async function lookup(businessId, input) {
  const code = normalizeCode(input);
  if (!code) return null;
  const custom = await knex('icd_custom_codes').where({ business_id: businessId, is_active: true }).whereRaw('UPPER(code) = ?', [code]).first('id', 'code', 'title_ar', 'title_en');
  if (custom) return { code: custom.code, title_ar: custom.title_ar, title_en: custom.title_en || custom.title_ar, custom: true };
  const e = BY_CODE.get(code);
  return e ? { code: e.code, title_ar: e.ar, title_en: e.en, custom: false } : null;
}

const titleOf = (row, locale) => (locale === 'en' ? row.title_en || row.title_ar : row.title_ar || row.title_en) || '';

// ---------------------------------------------------------------- diagnoses of a visit
const listFor = (businessId, appointmentId) => knex('consultation_diagnoses').where({ business_id: businessId, appointment_id: appointmentId })
  .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'id', order: 'asc' }])
  .select('id', 'code', 'title_ar', 'title_en', 'is_primary', 'is_custom', 'created_at');

/** Coded diagnoses of one visit (primary first) — for documents, prints and other modules. */
const diagnosesFor = (businessId, appointmentId) => listFor(businessId, appointmentId);

/** Coded diagnoses of many visits at once: Map(appointment_id → rows). */
async function diagnosesByAppointment(businessId, appointmentIds) {
  const ids = [...new Set(appointmentIds.filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = await knex('consultation_diagnoses').where({ business_id: businessId }).whereIn('appointment_id', ids)
    .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'id', order: 'asc' }]).select('appointment_id', 'code', 'title_ar', 'title_en', 'is_primary');
  rows.forEach((r) => { if (!map.has(r.appointment_id)) map.set(r.appointment_id, []); map.get(r.appointment_id).push(r); });
  return map;
}

/** Splits the form input (repeated `icd_codes` fields and/or a comma separated list) into distinct codes. */
function parseCodes(input) {
  const raw = [].concat(input === undefined || input === null ? [] : input).join(',');
  return [...new Set(raw.split(/[,،;\n]+/).map((s) => normalizeCode(s)).filter(Boolean))].slice(0, 12);
}

/** Validates codes; throws a VALIDATION_FAILED error whose `icd_codes` detail lists the unknown codes. */
async function resolveCodes(businessId, input) {
  const codes = parseCodes(input);
  const found = []; const unknown = [];
  for (const c of codes) { const hit = await lookup(businessId, c); if (hit) found.push(hit); else unknown.push(c); } // eslint-disable-line no-await-in-loop
  if (unknown.length) throw E.validation({ icd_codes: unknown.join(', ') });
  return found;
}

/**
 * Replaces the coded diagnoses of a visit with `resolved` (from resolveCodes). `primary` is the primary code
 * (defaults to the first one). Audited when something changed.
 */
async function saveDiagnoses(ctx, appt, resolved, primary) {
  const primaryCode = resolved.some((r) => r.code === normalizeCode(primary)) ? normalizeCode(primary) : (resolved[0] || {}).code;
  await knex.transaction(async (trx) => {
    const existing = await trx('consultation_diagnoses').where({ business_id: ctx.businessId, appointment_id: appt.id }).select('id', 'code', 'is_primary');
    const keep = new Set(resolved.map((r) => r.code));
    const removed = existing.filter((r) => !keep.has(r.code));
    const have = new Set(existing.map((r) => r.code));
    const added = resolved.filter((r) => !have.has(r.code));
    if (removed.length) await trx('consultation_diagnoses').whereIn('id', removed.map((r) => r.id)).del();
    if (added.length) {
      await trx('consultation_diagnoses').insert(added.map((r) => ({
        business_id: ctx.businessId, appointment_id: appt.id, patient_id: appt.patient_id || null, doctor_id: appt.doctor_id || null,
        code: r.code, title_ar: r.title_ar, title_en: r.title_en, is_primary: r.code === primaryCode, is_custom: Boolean(r.custom), created_by: ctx.userId,
      })));
    }
    const primaryChanged = existing.some((r) => keep.has(r.code) && Boolean(r.is_primary) !== (r.code === primaryCode));
    if (primaryChanged) {
      await trx('consultation_diagnoses').where({ business_id: ctx.businessId, appointment_id: appt.id }).update({ is_primary: false });
      if (primaryCode) await trx('consultation_diagnoses').where({ business_id: ctx.businessId, appointment_id: appt.id, code: primaryCode }).update({ is_primary: true });
    }
    if (removed.length || added.length || primaryChanged) {
      await audit.record(ctx, 'consultation.diagnoses', { entityType: 'appointment', entityId: appt.id, oldValues: { codes: existing.map((r) => r.code) }, newValues: { codes: resolved.map((r) => r.code), primary: primaryCode || null } }, trx);
    }
  });
}

// ---------------------------------------------------------------- custom codes (Settings → Diagnosis codes)
const customSchema = z.object({
  code: z.string().trim().min(2, 'Required.').max(20, 'Too long.').regex(/^[A-Za-z0-9][A-Za-z0-9.\-_]*$/, 'Invalid value.'),
  title_ar: z.string().trim().min(1, 'Required.').max(255, 'Too long.'),
  title_en: optionalString(255),
});
const bool = (v) => v === '1' || v === 'on' || v === true;

async function saveCustom(ctx, id, input) {
  const d = validate(customSchema, input);
  const code = normalizeCode(d.code);
  if (BY_CODE.has(code)) throw new AppError('ICD_CODE_EXISTS', 'This code is already in the ICD-10 list.', 409);
  const dup = await knex('icd_custom_codes').where({ business_id: ctx.businessId }).whereRaw('UPPER(code) = ?', [code]).modify((q) => { if (id) q.whereNot('id', id); }).first('id');
  if (dup) throw new AppError('ICD_CODE_TAKEN', 'This code already exists.', 409);
  const row = { code, title_ar: d.title_ar, title_en: d.title_en || null, is_active: bool(input.is_active) };
  if (id) {
    const before = await knex('icd_custom_codes').where({ id, business_id: ctx.businessId }).first();
    if (!before) throw E.notFound('Diagnosis code');
    await knex('icd_custom_codes').where({ id, business_id: ctx.businessId }).update({ ...row, updated_at: new Date() });
    await audit.record(ctx, 'icd_custom_code.updated', { entityType: 'icd_custom_code', entityId: id, ...audit.diff(before, row) });
    return id;
  }
  const [newId] = await knex('icd_custom_codes').insert({ ...row, business_id: ctx.businessId, created_by: ctx.userId });
  await audit.record(ctx, 'icd_custom_code.created', { entityType: 'icd_custom_code', entityId: newId, newValues: row });
  return newId;
}

async function removeCustom(ctx, id) {
  const before = await knex('icd_custom_codes').where({ id, business_id: ctx.businessId }).first();
  if (!before) throw E.notFound('Diagnosis code');
  await knex('icd_custom_codes').where({ id, business_id: ctx.businessId }).del(); // visits keep their snapshot
  await audit.record(ctx, 'icd_custom_code.deleted', { entityType: 'icd_custom_code', entityId: id, oldValues: { code: before.code, title_ar: before.title_ar, title_en: before.title_en } });
}

module.exports = {
  norm, normalizeCode, rank, search, lookup, usage, titleOf, parseCodes, resolveCodes, saveDiagnoses, listFor, diagnosesFor, diagnosesByAppointment,
  saveCustom, removeCustom, INDEX, BY_CODE, SOURCE: { source: DATA.source, licence: DATA.licence, count: DATA.count },
};
