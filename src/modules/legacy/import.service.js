// Legacy Patient Recovery & Import — Clinica. Brings a previous system's patients, treatments, clinical tables and
// files into the clinic, tied to each patient by the old patient id (legacy_patient_id), never by name.
//
// A job goes: draft → (uploads) → analyzing → ready (preview) → processing → completed | completed_with_issues.
// Uploads (the patients JSON, the attachment ZIPs) are kept in private storage only while the job needs them; the
// JSON is a transport: every record becomes ordinary rows (legacy_patients, legacy_treatments, legacy_clinical_*,
// legacy_field_values, patient_attachments). Work runs in the background, item by item, each with its own status in
// import_items, so a stopped job (closed browser, restarted server, failure) carries on from the next pending item.
// Every record and file is keyed so importing it again adds nothing twice (idempotent):
//   patient   (clinic, source, old id)               treatment / clinical row  (old patient, row key)
//   file      (clinic, old patient id, SHA-256)       stored copy               one per SHA-256 per clinic
// Matching: a patient here with the same legacy_patient_id (else the same legacy_patient_number) is MATCHED; anything
// else is UNMATCHED — its data is kept (staged, linked to the old id) and no patient is created unless the person
// starting the import asks for it (and then never when the mobile number belongs to someone else here).
// Nothing here leaves the server: no external service, no AI, no analytics.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const knex = require('../../db/knex');
const tenant = require('../../db/tenant');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { ZipReader } = require('../../core/zipread');
const jsonstream = require('../../core/jsonstream');
const map = require('./clinica-map');
const files = require('./files');

const SOURCE = 'clinica';
const TYPE = 'legacy_clinica';
const ROOT = process.env.LEGACY_IMPORT_DIR || path.join(__dirname, '..', '..', '..', 'storage', 'legacy-import');
const OPEN = ['draft', 'analyzing', 'ready', 'processing'];
const STEP = 50; // items per round (each its own transaction)
const STALE_MS = 2 * 60_000; // a job whose runner went quiet this long is taken over (restarted server)

const fail = (code, message, status = 422) => new AppError(code, message, status);
const jobDir = (businessId, jobId) => path.join(ROOT, String(Number(businessId)), String(Number(jobId)));
const now = () => new Date();
const sha256File = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
const clip = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

async function logError(job, { item = null, batch = null, legacyId = null, file = null, stage, code, message, level = 'error' }, db = knex) {
  await db('import_errors').insert({
    business_id: job.business_id, job_id: job.id, item_id: item, batch_id: batch, legacy_patient_id: clip(legacyId, 64), file: clip(file, 500),
    stage, error_code: code, message: clip(message, 500), level,
  });
}

// ================================================================= jobs
async function getJob(businessId, id) {
  const j = await knex('import_jobs').where({ id: Number(id) || 0, business_id: businessId, type: TYPE }).first();
  if (!j) throw E.notFound('Import');
  return j;
}
const currentJob = (businessId) => knex('import_jobs').where({ business_id: businessId, type: TYPE }).whereIn('status', OPEN).orderBy('id', 'desc').first();
const jobs = (businessId) => knex('import_jobs').where({ business_id: businessId, type: TYPE }).orderBy('id', 'desc').limit(20);

/** The open job of the clinic, or a new one. */
async function openJob(ctx) {
  const cur = await currentJob(ctx.businessId);
  if (cur) return cur;
  const [id] = await knex('import_jobs').insert({ business_id: ctx.businessId, type: TYPE, status: 'draft', created_by: ctx.userId || null });
  await audit.record(ctx, 'legacy.import_job_created', { entityType: 'import_job', entityId: id, newValues: { source: SOURCE } });
  return getJob(ctx.businessId, id);
}

const editable = (j) => ['draft', 'ready', 'analyzing'].includes(j.status);

// ================================================================= uploads
/** Takes an uploaded file (multer, on disk) into the job → the batch row. */
async function addUpload(ctx, jobId, upload, kind) {
  const job = await getJob(ctx.businessId, jobId);
  if (!editable(job)) { fs.rmSync(upload.path, { force: true }); throw fail('IMPORT_LOCKED', 'This import has started; start a new one to add files.', 409); }
  const name = String(upload.originalname || 'upload').replace(/[\u0000-\u001f<>:"|?*\\/]/g, '').slice(0, 200) || 'upload';
  const ext = files.extOf(name);
  if (kind === 'patients_json' && ext !== 'json') { fs.rmSync(upload.path, { force: true }); throw fail('IMPORT_NOT_JSON', 'Choose the patients file (.json).'); }
  if (kind === 'attachments_zip' && ext !== 'zip') { fs.rmSync(upload.path, { force: true }); throw fail('IMPORT_NOT_ZIP', 'Choose the attachment archives (.zip).'); }
  const sha = await sha256File(upload.path);
  const dir = jobDir(ctx.businessId, job.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const same = await knex('import_batches').where({ job_id: job.id, sha256: sha }).whereNot('status', 'duplicate').first('id', 'original_name');
  const m = /(\d{1,3})\s*[-_ ]?of[-_ ]?\s*(\d{1,3})/i.exec(name);
  const row = {
    business_id: ctx.businessId, job_id: job.id, kind, original_name: name, size: upload.size || fs.statSync(upload.path).size, sha256: sha,
    batch_no: m ? Number(m[1]) : null, batch_total: m ? Number(m[2]) : null, uploaded_by: ctx.userId || null,
  };
  if (same) {
    fs.rmSync(upload.path, { force: true });
    const [id] = await knex('import_batches').insert({ ...row, status: 'duplicate', error: clip(`Same file as ${same.original_name}`, 255) });
    return knex('import_batches').where({ id }).first();
  }
  if (kind === 'patients_json') {
    // One patients file per import: a new one replaces the earlier one (and what was read from it).
    const old = await knex('import_batches').where({ job_id: job.id, kind }).whereNot('status', 'duplicate');
    for (const b of old) await dropBatch(job, b); // eslint-disable-line no-await-in-loop
  }
  const [id] = await knex('import_batches').insert({ ...row, status: 'uploaded' });
  const dest = path.join(dir, `batch-${id}.${ext}`);
  fs.renameSync(upload.path, dest);
  fs.chmodSync(dest, 0o600);
  await knex('import_batches').where({ id }).update({ stored_path: dest });
  await knex('import_jobs').where({ id: job.id }).update({ status: 'analyzing', stage: kind === 'patients_json' ? 'patients_analysis' : 'attachments_analysis', updated_at: now() });
  await audit.record(ctx, 'legacy.import_uploaded', { entityType: 'import_job', entityId: job.id, newValues: { kind, name, size: row.size, sha256: sha } });
  kick(ctx.businessId);
  return knex('import_batches').where({ id }).first();
}

/** Removes a batch and what was read from it (before the import starts). */
async function dropBatch(job, b) {
  await knex('import_items').where({ job_id: job.id, batch_id: b.id }).del();
  await knex('import_errors').where({ job_id: job.id, batch_id: b.id }).del();
  if (b.stored_path) fs.rmSync(b.stored_path, { force: true });
  if (b.kind === 'patients_json') fs.rmSync(path.join(jobDir(job.business_id, job.id), 'index.json'), { force: true });
  await knex('import_batches').where({ id: b.id }).del();
}

async function removeBatch(ctx, jobId, batchId) {
  const job = await getJob(ctx.businessId, jobId);
  if (!editable(job) || job.status === 'analyzing') throw fail('IMPORT_LOCKED', 'This import is busy; try again in a moment.', 409);
  const b = await knex('import_batches').where({ id: Number(batchId), job_id: job.id }).first();
  if (!b) throw E.notFound('File');
  await dropBatch(job, b);
  await audit.record(ctx, 'legacy.import_file_removed', { entityType: 'import_job', entityId: job.id, oldValues: { name: b.original_name } });
  await refreshTotals(job.id);
}

// ================================================================= matching (old patient → a patient here)
// In this order, the first that gives exactly one patient wins (never the name alone):
//   legacy_id      the patient here already carries this old id (linked before)
//   legacy_number  the patient here carries this old patient number
//   file_number    the patient's file number here is the old patient number (or the old id) AND the first name or the
//                  mobile agrees — the usual case when the clinic typed its patients with their old numbers
//   phone          the same mobile number (last 9 digits) AND the same first name — only when exactly one patient here
//                  has that mobile with that name
// A patient here already tied to another old id is never matched by file number or mobile, and two old patients that
// would land on the same patient are both left UNMATCHED (ambiguous) for a person to decide in the recovery list.
const normFile = (v) => { const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase(); return /^\d+$/.test(s) ? String(Number(s)) : s; };
const normPhone = (v) => { const d = String(v || '').replace(/\D+/g, ''); return d.length >= 9 ? d.slice(-9) : null; };
const firstName = (v) => require('../clinic/records.lib').foldText(String(v || '')).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().split(/\s+/)[0] || ''; // eslint-disable-line global-require

async function matchIndex(businessId) {
  const rows = await knex('patients').where({ business_id: businessId }).whereNull('transferred_at')
    .select('id', 'full_name', 'phone', 'phone2', 'file_number', 'legacy_source', 'legacy_patient_id', 'legacy_patient_number');
  const ix = { byId: new Map(), byNumber: new Map(), byFile: new Map(), byPhone: new Map(), tied: new Map() };
  const push = (m, k, v) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  rows.forEach((r) => {
    if (r.legacy_patient_id && (!r.legacy_source || r.legacy_source === SOURCE)) ix.byId.set(String(r.legacy_patient_id), r.id);
    if (r.legacy_patient_id) ix.tied.set(r.id, String(r.legacy_patient_id));
    if (r.legacy_patient_number) push(ix.byNumber, normFile(r.legacy_patient_number), r.id);
    const name = firstName(r.full_name);
    if (r.file_number) push(ix.byFile, normFile(r.file_number), { id: r.id, name, phones: [r.phone, r.phone2].map(normPhone).filter(Boolean) });
    [r.phone, r.phone2].map(normPhone).filter(Boolean).forEach((ph) => push(ix.byPhone, ph, { id: r.id, name }));
  });
  const staged = await knex('legacy_patients').where({ business_id: businessId, legacy_source: SOURCE }).whereNotNull('patient_id').select('legacy_patient_id', 'patient_id');
  staged.forEach((r) => { if (!ix.byId.has(r.legacy_patient_id)) ix.byId.set(r.legacy_patient_id, r.patient_id); ix.tied.set(r.patient_id, r.legacy_patient_id); });
  return ix;
}

/** The patient here for one old patient → { id, by } or null. */
function candidate(ix, { id, number, mobile, name }) {
  const exact = ix.byId.get(String(id));
  if (exact) return { id: exact, by: 'legacy_id' };
  const free = (pid) => !ix.tied.has(pid) || ix.tied.get(pid) === String(id);
  const one = (list) => { const l = [...new Set((list || []).filter(free))]; return l.length === 1 ? l[0] : null; };
  const n = number ? normFile(number) : null;
  let hit = n && one(ix.byNumber.get(n));
  if (hit) return { id: hit, by: 'legacy_number' };
  // A file number counts only when the first name or the mobile agrees too (numbers given automatically here — 1, 2,
  // 3… — can be the same numbers as the old system's for other people).
  const ph = normPhone(mobile); const fn = firstName(name);
  const agrees = (c) => (fn && c.name === fn) || (ph && c.phones.includes(ph));
  const byFile = (k) => one((ix.byFile.get(k) || []).filter(agrees).map((c) => c.id));
  hit = (n && byFile(n)) || byFile(normFile(id));
  if (hit) return { id: hit, by: 'file_number' };
  if (ph && fn) {
    hit = one((ix.byPhone.get(ph) || []).filter((c) => c.name === fn).map((c) => c.id));
    if (hit) return { id: hit, by: 'phone' };
  }
  return null;
}

/** Matches (again) every old patient of the job; two old patients on one patient → both ambiguous. */
async function rematch(job) {
  const ix = await matchIndex(job.business_id);
  const items = await knex('import_items').where({ job_id: job.id, kind: 'patient' }).whereIn('status', ['pending', 'unmatched'])
    .select('id', 'legacy_patient_id', 'legacy_patient_number', 'mobile', 'display_name');
  const res = new Map(); const claims = new Map();
  items.forEach((it) => {
    const c = candidate(ix, { id: it.legacy_patient_id, number: it.legacy_patient_number, mobile: it.mobile, name: it.display_name });
    res.set(it.id, c);
    if (c) { if (!claims.has(c.id)) claims.set(c.id, []); claims.get(c.id).push(it); }
  });
  await knex('import_errors').where({ job_id: job.id, error_code: 'AMBIGUOUS_MATCH' }).del();
  for (const [pid, list] of claims) { // eslint-disable-line no-restricted-syntax
    if (list.length < 2) continue; // eslint-disable-line no-continue
    for (const it of list) { // eslint-disable-line no-restricted-syntax
      res.set(it.id, { id: null, by: 'ambiguous' });
      await logError(job, { item: it.id, legacyId: it.legacy_patient_id, stage: 'matching', code: 'AMBIGUOUS_MATCH', level: 'warning', message: `${list.length} old patients (${list.map((x) => x.legacy_patient_id).join(', ')}) point at the same patient here (#${pid}); link them by hand.` }); // eslint-disable-line no-await-in-loop
    }
  }
  await knex.transaction(async (trx) => {
    for (const it of items) { // eslint-disable-line no-restricted-syntax
      const c = res.get(it.id);
      await trx('import_items').where({ id: it.id }).update({ match: c && c.id ? 'matched' : 'unmatched', match_by: c ? c.by : null, target_id: c && c.id ? c.id : null }); // eslint-disable-line no-await-in-loop
    }
  });
}

async function analyzePatients(job, batch) {
  await knex('import_batches').where({ id: batch.id }).update({ status: 'analyzing' });
  await knex('import_items').where({ job_id: job.id, batch_id: batch.id }).del();
  await knex('import_errors').where({ job_id: job.id, batch_id: batch.id }).del();
  const index = {}; // old id → [[role, offset, length]] for lists outside the patient records
  const seen = new Set();
  let patients = 0; let treatments = 0; let clinical = 0; let links = 0; let bad = 0;
  let pending = [];
  const flush = async () => { if (pending.length) { await knex('import_items').insert(pending).onConflict(['job_id', 'kind', 'ref']).ignore(); pending = []; } };
  try {
    for await (const ev of jsonstream.scan(batch.stored_path)) { // eslint-disable-line no-restricted-syntax
      if (ev.type !== 'element') continue; // eslint-disable-line no-continue
      const role = map.roleOf(ev.path);
      let el;
      try { el = JSON.parse(ev.text); } catch { bad += 1; await logError(job, { batch: batch.id, stage: 'patients_analysis', code: 'INVALID_RECORD', message: `Record ${ev.index + 1} of "${ev.path || 'patients'}" is not valid.` }); continue; } // eslint-disable-line no-await-in-loop, no-continue
      if (role === 'patients') {
        patients += 1;
        const p = map.patient(el);
        if (!p.id) { bad += 1; await logError(job, { batch: batch.id, stage: 'patients_analysis', code: 'MISSING_PATIENT_ID', message: `Patient record ${ev.index + 1} has no patient id${p.name ? ` (${p.name})` : ''}.` }); continue; } // eslint-disable-line no-await-in-loop, no-continue
        if (seen.has(p.id)) { await logError(job, { batch: batch.id, legacyId: p.id, stage: 'patients_analysis', code: 'DUPLICATE_PATIENT_ID', message: `Patient id ${p.id} appears more than once; the first record is used.`, level: 'warning' }); continue; } // eslint-disable-line no-await-in-loop, no-continue
        seen.add(p.id);
        const nClin = p.clinical.reduce((n, tb) => n + tb.rows.length, 0);
        treatments += p.treatments.length; clinical += nClin; links += p.attachments.length;
        pending.push({
          business_id: job.business_id, job_id: job.id, batch_id: batch.id, kind: 'patient', ref: p.id, legacy_patient_id: p.id, legacy_patient_number: clip(p.number, 64),
          display_name: clip(p.name, 190), src_offset: ev.offset, src_length: ev.length, source_checksum: crypto.createHash('sha256').update(ev.text).digest('hex'),
          mobile: clip(p.mobile || p.telephone, 60), status: 'pending', treatments: p.treatments.length, clinical: nClin, links: p.attachments.length,
        });
        if (pending.length >= 500) await flush(); // eslint-disable-line no-await-in-loop
      } else if (['treatments', 'clinical', 'attachments'].includes(role)) {
        const owner = map.ownerOf(el);
        if (!owner) { bad += 1; await logError(job, { batch: batch.id, stage: 'patients_analysis', code: 'MISSING_PATIENT_ID', message: `Record ${ev.index + 1} of "${ev.path}" has no patient id.` }); continue; } // eslint-disable-line no-await-in-loop, no-continue
        (index[owner] = index[owner] || []).push([role, ev.path, ev.offset, ev.length]);
        if (role === 'treatments') treatments += 1; else if (role === 'clinical') clinical += 1; else links += 1;
      }
      if (patients % 200 === 0) await knex('import_jobs').where({ id: job.id }).update({ heartbeat_at: now() }); // eslint-disable-line no-await-in-loop
    }
    await flush();
  } catch (e) {
    await knex('import_batches').where({ id: batch.id }).update({ status: 'invalid', error: clip(e.code === 'JSON_INVALID' ? `Not valid JSON (byte ${e.at})` : e.message, 255) });
    await logError(job, { batch: batch.id, stage: 'patients_analysis', code: e.code || 'JSON_INVALID', message: e.message });
    return;
  }
  // Records of the separate lists whose patient is not in the file are reported (they cannot be tied to anyone).
  const orphans = Object.keys(index).filter((id) => !seen.has(id));
  for (const id of orphans.slice(0, 500)) await logError(job, { batch: batch.id, legacyId: id, stage: 'patients_analysis', code: 'ORPHAN_RECORDS', message: `${index[id].length} record(s) belong to patient id ${id}, who is not in the file.` }); // eslint-disable-line no-await-in-loop
  fs.writeFileSync(path.join(jobDir(job.business_id, job.id), 'index.json'), JSON.stringify(index), { mode: 0o600 });
  await knex('import_batches').where({ id: batch.id }).update({ status: patients ? 'valid' : 'invalid', entries: patients, valid_files: seen.size, invalid_files: bad, error: patients ? null : 'No patient records were found.' });
  await knex('import_jobs').where({ id: job.id }).update({ src_patients: seen.size, src_treatments: treatments, src_clinical: clinical, src_links: links });
  await rematch(job);
}

// ================================================================= analysis: attachment ZIPs
function manifestEntries(raw) {
  let v;
  try { v = JSON.parse(raw); } catch {
    // JSON Lines
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    try { v = lines.map((l) => JSON.parse(l)); } catch { return null; }
  }
  if (Array.isArray(v)) return { list: v, meta: {} };
  if (v && typeof v === 'object') {
    const k = map.pickKey(v, ['files', 'items', 'entries', 'attachments', 'manifest', 'records']);
    if (k && Array.isArray(v[k])) return { list: v[k], meta: v };
    if (map.pickKey(v, ['zip_path', 'saved_filename', 'patient_id'])) return { list: [v], meta: {} };
  }
  return null;
}
const fieldOf = (o, names) => { const k = map.pickKey(o, names); return k === null || o[k] === null || o[k] === undefined ? null : String(o[k]).trim(); };

async function analyzeZip(job, batch) {
  await knex('import_batches').where({ id: batch.id }).update({ status: 'analyzing' });
  await knex('import_items').where({ job_id: job.id, batch_id: batch.id }).del();
  await knex('import_errors').where({ job_id: job.id, batch_id: batch.id }).del();
  let zip;
  const invalid = async (code, message) => {
    await knex('import_batches').where({ id: batch.id }).update({ status: 'invalid', error: clip(message, 255) });
    await logError(job, { batch: batch.id, file: batch.original_name, stage: 'zip_analysis', code, message });
  };
  try { zip = new ZipReader(batch.stored_path); } catch { return invalid('CORRUPTED_ZIP', `${batch.original_name} is damaged or not a ZIP file.`); }
  try {
    const names = zip.names();
    const manifestName = names.filter((n) => /(^|\/)manifest\.json$/i.test(n)).sort((a, b) => a.length - b.length)[0];
    if (!manifestName) return invalid('MISSING_MANIFEST', `${batch.original_name} has no manifest.json.`);
    let raw;
    try { raw = zip.read(manifestName).toString('utf8').replace(/^﻿/, ''); } catch { return invalid('CORRUPTED_ZIP', `The manifest of ${batch.original_name} cannot be read.`); }
    const man = manifestEntries(raw);
    if (!man) return invalid('INVALID_MANIFEST', `The manifest of ${batch.original_name} is not valid JSON.`);
    const base = manifestName.includes('/') ? manifestName.slice(0, manifestName.lastIndexOf('/') + 1) : '';
    // Batch number / total from the manifest when it says, else from the file name (already read at upload).
    const bn = Number(fieldOf(man.meta, ['batch', 'batch_number', 'batch_no', 'part', 'part_number']));
    const bt = Number(fieldOf(man.meta, ['total_batches', 'batches', 'batch_total', 'parts', 'total_parts']));
    if (bn > 0 && bt > 0) await knex('import_batches').where({ id: batch.id }).update({ batch_no: bn, batch_total: bt });
    const listed = new Set();
    let ok = 0; let bad = 0;
    for (const [i, m] of man.list.entries()) { // eslint-disable-line no-restricted-syntax
      if (!m || typeof m !== 'object') { bad += 1; await logError(job, { batch: batch.id, stage: 'zip_analysis', code: 'INVALID_MANIFEST', message: `Entry ${i + 1} of the manifest is not an object.` }); continue; } // eslint-disable-line no-await-in-loop, no-continue
      const pid = fieldOf(m, ['patient_id', 'legacy_patient_id', 'patientid']);
      const saved = fieldOf(m, ['saved_filename', 'stored_filename', 'filename', 'file_name']);
      let zp = fieldOf(m, ['zip_path', 'path', 'archive_path']);
      if (!zp && pid && saved) zp = `${pid}/${saved}`;
      zp = zp ? (base + zp.replace(/\\/g, '/').replace(/^\.?\//, '')).split('/').filter((s) => s && s !== '.' && s !== '..').join('/') : null;
      const item = {
        business_id: job.business_id, job_id: job.id, batch_id: batch.id, kind: 'attachment', ref: clip(zp || `manifest:${batch.id}:${i}`, 500),
        legacy_patient_id: clip(pid, 64), legacy_patient_number: clip(fieldOf(m, ['patient_number', 'legacy_patient_number', 'number']), 64),
        display_name: clip(fieldOf(m, ['original_filename', 'name']) || saved || (zp && zp.split('/').pop()), 190), status: 'pending',
      };
      const err = async (code, message, level = 'error') => { await logError(job, { batch: batch.id, legacyId: pid, file: zp || saved, stage: 'zip_analysis', code, message, level }); };
      const status = (fieldOf(m, ['status']) || 'downloaded').toLowerCase();
      if (zp) listed.add(zp);
      if (!pid) { bad += 1; await err('MISSING_PATIENT_ID', 'The manifest entry has no patient id.'); await insertItem({ ...item, status: 'invalid', message: 'MISSING_PATIENT_ID' }); continue; } // eslint-disable-line no-await-in-loop, no-continue
      if (!['downloaded', 'ok', 'success', 'done', 'saved'].includes(status)) { await err('SOURCE_NOT_DOWNLOADED', `The old system's file was not downloaded (status: ${status}).`, 'warning'); await insertItem({ ...item, status: 'skipped', message: 'SOURCE_NOT_DOWNLOADED' }); continue; } // eslint-disable-line no-await-in-loop, no-continue
      if (!zp || !zip.has(zp)) { bad += 1; await err('FILE_MISSING', 'The manifest lists this file but it is not in the ZIP.'); await insertItem({ ...item, status: 'invalid', message: 'FILE_MISSING' }); continue; } // eslint-disable-line no-await-in-loop, no-continue
      const folder = zp.slice(base.length).split('/')[0];
      if (zp.slice(base.length).includes('/') && folder !== pid) { bad += 1; await err('PATIENT_FOLDER_MISMATCH', `The file is in folder ${folder} but the manifest says patient ${pid}.`); await insertItem({ ...item, status: 'invalid', message: 'PATIENT_FOLDER_MISMATCH' }); continue; } // eslint-disable-line no-await-in-loop, no-continue
      const v = await validateEntry(zip, zp, m, (code, msg) => err(code, msg)); // eslint-disable-line no-await-in-loop
      if (!v) { bad += 1; await insertItem({ ...item, status: 'invalid', message: 'FILE_VALIDATION_ERROR' }); continue; } // eslint-disable-line no-await-in-loop, no-continue
      const dup = await knex('import_items').where({ job_id: job.id, kind: 'attachment', ref: item.ref }).first('id', 'batch_id'); // eslint-disable-line no-await-in-loop
      if (dup) { await err('DUPLICATE_FILE', 'The same file is in another uploaded ZIP; it is imported once.', 'warning'); continue; } // eslint-disable-line no-await-in-loop, no-continue
      await insertItem({ ...item, size: v.size, mime: v.mime, source_checksum: v.sha }); // eslint-disable-line no-await-in-loop
      ok += 1;
    }
    // Files of the ZIP that the manifest does not list: kept by their folder (the patient id), with a warning.
    for (const n of names) { // eslint-disable-line no-restricted-syntax
      if (n === manifestName || listed.has(n) || !n.startsWith(base)) continue; // eslint-disable-line no-continue
      const parts = n.slice(base.length).split('/');
      if (parts.length < 2 || /^(__MACOSX|\.)/.test(parts[0]) || parts[parts.length - 1].startsWith('.')) continue; // eslint-disable-line no-continue
      await logError(job, { batch: batch.id, legacyId: parts[0], file: n, stage: 'zip_analysis', code: 'NOT_IN_MANIFEST', message: 'This file is not in the manifest; it is tied to the patient of its folder.', level: 'warning' }); // eslint-disable-line no-await-in-loop
      const v = await validateEntry(zip, n, {}, async (code, msg) => logError(job, { batch: batch.id, legacyId: parts[0], file: n, stage: 'zip_analysis', code, message: msg })); // eslint-disable-line no-await-in-loop
      const dup = await knex('import_items').where({ job_id: job.id, kind: 'attachment', ref: n }).first('id'); // eslint-disable-line no-await-in-loop
      if (dup) continue; // eslint-disable-line no-continue
      await insertItem({ business_id: job.business_id, job_id: job.id, batch_id: batch.id, kind: 'attachment', ref: clip(n, 500), legacy_patient_id: clip(parts[0], 64), display_name: clip(parts[parts.length - 1], 190), status: v ? 'pending' : 'invalid', size: v ? v.size : null, mime: v ? v.mime : null, source_checksum: v ? v.sha : null, message: v ? null : 'FILE_VALIDATION_ERROR' }); // eslint-disable-line no-await-in-loop
      if (v) ok += 1; else bad += 1;
    }
    await knex('import_batches').where({ id: batch.id }).update({ status: 'valid', entries: man.list.length, valid_files: ok, invalid_files: bad, error: null });
  } finally { zip.close(); }
  return null;
}

const insertItem = (row) => knex('import_items').insert(row).onConflict(['job_id', 'kind', 'ref']).ignore();

/** Checks a ZIP entry against its manifest entry: exists, size, real type, checksum → { sha, size, mime } or null. */
async function validateEntry(zip, name, m, err) {
  let buf;
  try { buf = zip.read(name); } catch (e) { await err(/too large/i.test(e.message) ? 'FILE_TOO_LARGE' : 'CORRUPTED_FILE', `The file cannot be read from the ZIP (${e.message}).`); return null; }
  if (!buf) { await err('FILE_MISSING', 'The file is not in the ZIP.'); return null; }
  const want = Number(fieldOf(m, ['size', 'file_size', 'bytes']));
  if (Number.isFinite(want) && want > 0 && want !== buf.length) { await err('SIZE_MISMATCH', `The manifest says ${want} bytes; the file has ${buf.length}.`); return null; }
  const sha = files.sha256(buf);
  const sum = (fieldOf(m, ['sha256', 'checksum', 'hash']) || '').toLowerCase();
  if (sum && /^[a-f0-9]{64}$/.test(sum) && sum !== sha) { await err('CHECKSUM_MISMATCH', 'The SHA-256 of the file does not match the manifest.'); return null; }
  const md5 = (fieldOf(m, ['md5']) || '').toLowerCase();
  if (md5 && /^[a-f0-9]{32}$/.test(md5) && md5 !== crypto.createHash('md5').update(buf).digest('hex')) { await err('CHECKSUM_MISMATCH', 'The MD5 of the file does not match the manifest.'); return null; }
  const fname = fieldOf(m, ['original_filename', 'saved_filename']) || name;
  const mime = files.typeOf(name, buf) || files.typeOf(fname, buf);
  if (!mime) { await err('MIME_MISMATCH', `The content of the file is not a .${files.extOf(name)} file.`); return null; }
  return { sha, size: buf.length, mime };
}

// ================================================================= totals & preview
async function refreshTotals(jobId) {
  const [att] = await knex('import_items').where({ job_id: jobId, kind: 'attachment' }).count({ n: '*' });
  await knex('import_jobs').where({ id: jobId }).update({ src_attachments: Number(att.n), updated_at: now() });
}

async function counts(jobId) {
  const rows = await knex('import_items').where({ job_id: jobId }).groupBy('kind', 'status', 'match', 'match_by').select('kind', 'status', 'match', 'match_by').count({ n: '*' });
  const c = { patient: {}, attachment: {}, match: {}, by: {} };
  rows.forEach((r) => {
    c[r.kind][r.status] = (c[r.kind][r.status] || 0) + Number(r.n);
    if (r.kind === 'patient' && r.match) c.match[r.match] = (c.match[r.match] || 0) + Number(r.n);
    if (r.kind === 'patient' && r.match_by) c.by[r.match_by] = (c.by[r.match_by] || 0) + Number(r.n);
  });
  return c;
}

/** Everything the preview / dashboard shows for a job. */
async function summary(businessId, jobId) {
  const job = await getJob(businessId, jobId);
  const [batches, c, errs] = await Promise.all([
    knex('import_batches').where({ job_id: job.id }).orderBy([{ column: 'kind', order: 'desc' }, { column: 'batch_no' }, { column: 'id' }]),
    counts(job.id),
    knex('import_errors').where({ job_id: job.id }).groupBy('level', 'status').select('level', 'status').count({ n: '*' }),
  ]);
  const zips = batches.filter((b) => b.kind === 'attachments_zip');
  const zipsOk = zips.filter((b) => b.status !== 'duplicate');
  const expected = Math.max(0, ...zipsOk.map((b) => Number(b.batch_total) || 0));
  const have = new Set(zipsOk.map((b) => b.batch_no).filter(Boolean));
  const missing = expected ? Array.from({ length: expected }, (_, i) => i + 1).filter((n) => !have.has(n)) : [];
  const att = c.attachment;
  const errorCount = (lvl) => errs.filter((e) => e.level === lvl && e.status === 'open').reduce((n, e) => n + Number(e.n), 0);
  const p = c.patient;
  const totalItems = Object.values(p).reduce((a, b) => a + b, 0) + Object.values(att).reduce((a, b) => a + b, 0);
  const doneItems = totalItems - (p.pending || 0) - (p.processing || 0) - (att.pending || 0) - (att.processing || 0);
  return {
    job, batches,
    patientsFile: batches.find((b) => b.kind === 'patients_json' && b.status !== 'duplicate') || null,
    zips: { list: zips, detected: zipsOk.length, expected: expected || null, valid: zipsOk.filter((b) => b.status === 'valid').length, invalid: zipsOk.filter((b) => b.status === 'invalid').length, duplicates: zips.length - zipsOk.length, missing, analyzing: zipsOk.filter((b) => ['uploaded', 'analyzing'].includes(b.status)).length },
    patients: { detected: job.src_patients, matched: c.match.matched || 0, unmatched: c.match.unmatched || 0, created: c.match.new || 0, status: p, by: c.by },
    treatments: job.src_treatments, clinical: job.src_clinical, links: job.src_links,
    files: {
      total: Object.values(att).reduce((a, b) => a + b, 0), valid: (att.pending || 0) + (att.processing || 0) + (att.imported || 0) + (att.duplicate || 0) + (att.failed || 0),
      invalid: att.invalid || 0, skipped: att.skipped || 0, imported: att.imported || 0, duplicates: att.duplicate || 0, failed: att.failed || 0,
      unmatched: att.unmatched || 0,
    },
    errors: errorCount('error'), warnings: errorCount('warning'),
    progress: totalItems ? Math.round((doneItems / totalItems) * 1000) / 10 : 0,
  };
}

// ================================================================= start
async function start(ctx, jobId, { createUnmatched = false } = {}) {
  const job = await getJob(ctx.businessId, jobId);
  if (job.status !== 'ready') throw fail('IMPORT_NOT_READY', 'The files are still being checked.', 409);
  const s = await summary(ctx.businessId, job.id);
  if (!s.patientsFile || s.patientsFile.status !== 'valid') throw fail('IMPORT_NO_PATIENTS', 'Upload the patients file first.', 409);
  const n = await knex('import_jobs').where({ id: job.id, status: 'ready' }).update({
    status: 'processing', stage: 'patients_import', create_unmatched: Boolean(createUnmatched), started_at: now(), heartbeat_at: null,
    total: s.patients.detected + s.files.valid, processed: 0, success: 0, failed: 0, skipped: 0,
  });
  if (!n) throw fail('IMPORT_NOT_READY', 'The files are still being checked.', 409);
  await audit.record(ctx, 'legacy.import_started', { entityType: 'import_job', entityId: job.id, newValues: { patients: s.patients.detected, treatments: s.treatments, attachments: s.files.total, create_unmatched: Boolean(createUnmatched) } });
  kick(ctx.businessId);
}

/** Runs the matching again (e.g. after patients were added or numbered here) — before the import starts. */
async function rematchJob(ctx, jobId) {
  const job = await getJob(ctx.businessId, jobId);
  if (job.status !== 'ready') throw fail('IMPORT_NOT_READY', 'The files are still being checked.', 409);
  await rematch(job);
  await audit.record(ctx, 'legacy.import_rematched', { entityType: 'import_job', entityId: job.id });
}

async function cancel(ctx, jobId) {
  const job = await getJob(ctx.businessId, jobId);
  if (job.status === 'processing') throw fail('IMPORT_RUNNING', 'The import is running; it can be cancelled before it starts.', 409);
  if (!OPEN.includes(job.status)) return;
  await knex('import_jobs').where({ id: job.id }).update({ status: 'cancelled', completed_at: now() });
  fs.rmSync(jobDir(ctx.businessId, job.id), { recursive: true, force: true });
  await knex('import_batches').where({ job_id: job.id }).update({ stored_path: null });
  await audit.record(ctx, 'legacy.import_cancelled', { entityType: 'import_job', entityId: job.id });
}

// ================================================================= import: one patient
async function readIndex(job) {
  try { return JSON.parse(fs.readFileSync(path.join(jobDir(job.business_id, job.id), 'index.json'), 'utf8')); } catch { return {}; }
}

async function importPatient(job, item, index, file) {
  const text = await jsonstream.readSlice(file, Number(item.src_offset), Number(item.src_length));
  if (crypto.createHash('sha256').update(text).digest('hex') !== item.source_checksum) throw fail('SOURCE_CHANGED', 'The patients file changed since it was checked.');
  const p = map.patient(JSON.parse(text));
  if (p.id !== item.ref) throw fail('SOURCE_CHANGED', 'The patients file changed since it was checked.');
  // Records of the separate lists (treatments: [...] beside patients: [...]).
  for (const [role, listName, offset, length] of index[p.id] || []) { // eslint-disable-line no-restricted-syntax
    const el = JSON.parse(await jsonstream.readSlice(file, offset, length)); // eslint-disable-line no-await-in-loop
    if (role === 'treatments') p.treatments.push(map.treatment(el, p.treatments.length));
    else if (role === 'clinical') {
      // The table: its own field (table / table_key) when the list mixes tables, else the list's name (periodontal…).
      const tk = map.pickKey(el, ['table', 'table_key']);
      const key = String(tk ? el[tk] : listName || 'clinical').replace(/[^\p{L}\p{N}_\- ]+/gu, '').trim().slice(0, 60) || 'clinical';
      let tb = p.clinical.find((x) => x.key === key);
      if (!tb) { tb = { key, rows: [] }; p.clinical.push(tb); }
      const pos = tb.rows.length;
      tb.rows.push({ row_key: `fp:${crypto.createHash('sha256').update(JSON.stringify(el)).digest('hex').slice(0, 40)}:${pos}`.slice(0, 64), position: pos, values: map.flatten(el) });
    } else if (role === 'attachments') {
      p.attachments.push({ url: map.flatten(el).find(([k]) => /url|link|href/i.test(k))?.[1] || null, name: map.flatten(el).find(([k]) => /name|title/i.test(k))?.[1] || null });
    }
  }
  const business = job.business_id;
  let created = false;
  await knex.transaction(async (trx) => {
    // Who this patient is here: matched by the old id (else the old number), or — when asked — a new patient file.
    let pid = (await trx('patients').where({ business_id: business, legacy_source: SOURCE, legacy_patient_id: p.id }).first('id'))?.id
      || (await trx('legacy_patients').where({ business_id: business, legacy_source: SOURCE, legacy_patient_id: p.id }).whereNotNull('patient_id').first('patient_id'))?.patient_id
      // else the patient chosen by the matching (file number / mobile…), if it is still free for this old id
      || (item.target_id ? (await trx('patients').where({ id: item.target_id, business_id: business }).where((w) => w.whereNull('legacy_patient_id').orWhere({ legacy_source: SOURCE, legacy_patient_id: p.id })).first('id'))?.id : null)
      || null;
    if (!pid && job.create_unmatched && item.match_by !== 'ambiguous') {
      const phone = p.mobile ? String(p.mobile).replace(/[^\d+]/g, '').slice(0, 40) : null;
      const clash = phone ? await trx('patients').where({ business_id: business, phone }).first('id') : null;
      if (clash) {
        await logError(job, { item: item.id, legacyId: p.id, stage: 'patients_import', code: 'PHONE_BELONGS_TO_PATIENT', message: `Mobile ${phone} belongs to a patient here (#${clash.id}); link them by hand if they are the same person.`, level: 'warning' }, trx);
      } else {
        [pid] = await trx('patients').insert({
          business_id: business, full_name: clip(p.name, 190) || `#${p.id}`, phone, file_number: null,
          legacy_source: SOURCE, legacy_patient_id: p.id, legacy_patient_number: clip(p.number, 64), legacy_import_job_id: job.id, legacy_imported_at: now(),
        });
        created = true;
      }
    }
    const lp = {
      business_id: business, legacy_source: SOURCE, legacy_patient_id: p.id, legacy_patient_number: clip(p.number, 64), old_name: clip(p.name, 190),
      old_mobile: clip(p.mobile, 60), old_telephone: clip(p.telephone, 60), old_group: clip(p.group, 190), nationality: clip(p.nationality, 100),
      gender: clip(p.gender, 20), birth_date: clip(p.birth, 40), email: clip(p.email, 190), source_checksum: item.source_checksum, import_job_id: job.id,
    };
    const existing = await trx('legacy_patients').where({ business_id: business, legacy_source: SOURCE, legacy_patient_id: p.id }).first('id', 'patient_id');
    let ref;
    if (existing) { ref = existing.id; await trx('legacy_patients').where({ id: ref }).update({ ...lp, patient_id: existing.patient_id || pid || null, updated_at: now() }); pid = existing.patient_id || pid; }
    else [ref] = await trx('legacy_patients').insert({ ...lp, patient_id: pid || null });
    // Links and the other fields: replaced as a whole (the same record gives the same rows).
    await trx('legacy_patient_links').where({ legacy_patient_ref: ref }).del();
    const urls = new Map();
    p.links.forEach((l) => { if (l.url && !urls.has(l.url)) urls.set(l.url, { label: l.label, url: l.url }); });
    p.attachments.forEach((a) => { if (a.url && !urls.has(a.url)) urls.set(a.url, { label: a.name || 'attachment', url: a.url }); });
    if (urls.size) await trx('legacy_patient_links').insert([...urls.values()].map((l) => ({ business_id: business, legacy_patient_ref: ref, label: clip(l.label, 190), url: clip(l.url, 1000) })));
    await trx('legacy_field_values').where({ owner_type: 'patient', owner_id: ref }).del();
    if (p.extra.length) await insertChunks(trx, 'legacy_field_values', p.extra.map(([field, value], i) => ({ business_id: business, owner_type: 'patient', owner_id: ref, position: i, field: clip(field, 190), value })));
    // Treatments: one row each, never twice (row key).
    const have = new Set(await trx('legacy_treatments').where({ legacy_patient_ref: ref }).pluck('row_key'));
    for (const t of p.treatments) { // eslint-disable-line no-restricted-syntax
      if (have.has(t.row.row_key)) continue; // eslint-disable-line no-continue
      have.add(t.row.row_key);
      const [tid] = await trx('legacy_treatments').insert({ business_id: business, legacy_patient_ref: ref, patient_id: pid || null, legacy_patient_id: p.id, import_job_id: job.id, ...t.row }); // eslint-disable-line no-await-in-loop
      if (t.extra.length) await insertChunks(trx, 'legacy_field_values', t.extra.map(([field, value], i) => ({ business_id: business, owner_type: 'treatment', owner_id: tid, position: i, field: clip(field, 190), value }))); // eslint-disable-line no-await-in-loop
    }
    // Clinical tables: a record per row, a value per field.
    const haveRows = new Set((await trx('legacy_clinical_records').where({ legacy_patient_ref: ref }).select('table_key', 'row_key')).map((r) => `${r.table_key}\u0000${r.row_key}`));
    for (const tb of p.clinical) { // eslint-disable-line no-restricted-syntax
      for (const row of tb.rows) { // eslint-disable-line no-restricted-syntax
        if (haveRows.has(`${tb.key}\u0000${row.row_key}`)) continue; // eslint-disable-line no-continue
        haveRows.add(`${tb.key}\u0000${row.row_key}`);
        const [rid] = await trx('legacy_clinical_records').insert({ business_id: business, legacy_patient_ref: ref, patient_id: pid || null, legacy_patient_id: p.id, table_key: tb.key, row_key: row.row_key, position: row.position, import_job_id: job.id }); // eslint-disable-line no-await-in-loop
        if (row.values.length) await insertChunks(trx, 'legacy_clinical_values', row.values.map(([field, value], i) => ({ business_id: business, record_id: rid, position: i, field: clip(field, 190), value }))); // eslint-disable-line no-await-in-loop
      }
    }
    if (pid) await linkRows(trx, business, ref, p.id, pid, job.id, p.number);
    await trx('import_items').where({ id: item.id }).update({ status: pid ? 'imported' : 'unmatched', match: created ? 'new' : (pid ? 'matched' : 'unmatched'), target_id: pid || null, message: null, updated_at: now() });
  });
  return { pid: null, created };
}

async function insertChunks(trx, table, rows) { for (let i = 0; i < rows.length; i += 500) await trx(table).insert(rows.slice(i, i + 500)); } // eslint-disable-line no-await-in-loop

/** Ties an old patient's staged rows (treatments, clinical, files) to a patient here, and marks the patient. */
async function linkRows(trx, business, ref, legacyId, pid, jobId, number = null) {
  await trx('legacy_patients').where({ id: ref }).update({ patient_id: pid, updated_at: now() });
  await trx('legacy_treatments').where({ legacy_patient_ref: ref }).update({ patient_id: pid });
  await trx('legacy_clinical_records').where({ legacy_patient_ref: ref }).update({ patient_id: pid });
  await trx('patient_attachments').where({ business_id: business, legacy_source: SOURCE, legacy_patient_id: legacyId }).update({ patient_id: pid, legacy_patient_ref: ref });
  await trx('patients').where({ id: pid, business_id: business }).whereNull('legacy_patient_id').update({
    legacy_source: SOURCE, legacy_patient_id: legacyId, legacy_patient_number: number, legacy_import_job_id: jobId, legacy_imported_at: now(),
  });
  // Linked before (same old id): only what it lacks is filled in.
  if (number) await trx('patients').where({ id: pid, business_id: business, legacy_patient_id: legacyId }).whereNull('legacy_patient_number').update({ legacy_patient_number: number });
  await trx('patients').where({ id: pid, business_id: business, legacy_patient_id: legacyId }).whereNull('legacy_imported_at').update({ legacy_import_job_id: jobId, legacy_imported_at: now() });
}

// ================================================================= import: one file
async function importAttachment(job, item, zips) {
  const batch = zips.get(item.batch_id);
  if (!batch) throw fail('ZIP_GONE', 'The ZIP of this file is no longer on the server; upload it again.');
  if (!zips.reader.has(batch.id)) zips.reader.set(batch.id, new ZipReader(batch.stored_path));
  const buf = zips.reader.get(batch.id).read(item.ref);
  if (!buf) throw fail('FILE_MISSING', 'The file is not in the ZIP.');
  const sha = files.sha256(buf);
  if (sha !== item.source_checksum) throw fail('CHECKSUM_MISMATCH', 'The file changed since it was checked.');
  const business = job.business_id;
  const already = await knex('patient_attachments').where({ business_id: business, legacy_patient_id: item.legacy_patient_id, checksum: sha }).first('id');
  if (already) {
    await knex('import_items').where({ id: item.id }).update({ status: 'duplicate', target_id: already.id, message: 'ALREADY_IMPORTED', updated_at: now() });
    return 'duplicate';
  }
  const copy = await knex('patient_attachments').where({ business_id: business, checksum: sha }).whereNull('duplicate_of').first('id', 'storage_path');
  if (!copy || !files.exists(copy.storage_path)) await require('../storage/storage.service').assertRoom(business, buf.length); // eslint-disable-line global-require
  const storagePath = copy && files.exists(copy.storage_path) ? copy.storage_path : files.put(business, sha, buf);
  const lp = await knex('legacy_patients').where({ business_id: business, legacy_source: SOURCE, legacy_patient_id: item.legacy_patient_id }).first('id', 'patient_id', 'legacy_patient_number');
  const pid = (lp && lp.patient_id) || (await knex('patients').where({ business_id: business, legacy_source: SOURCE, legacy_patient_id: item.legacy_patient_id }).first('id'))?.id || null;
  // The manifest's own details of the file (name in the old system, its address there).
  const zip = zips.reader.get(batch.id);
  let meta = {};
  try {
    const mn = zip.names().filter((n) => /(^|\/)manifest\.json$/i.test(n)).sort((a, b) => a.length - b.length)[0];
    if (!zips.manifests.has(batch.id)) zips.manifests.set(batch.id, mn ? (manifestEntries(zip.read(mn).toString('utf8').replace(/^﻿/, '')) || { list: [] }).list : []);
    const base = mn && mn.includes('/') ? mn.slice(0, mn.lastIndexOf('/') + 1) : '';
    meta = zips.manifests.get(batch.id).find((m) => m && typeof m === 'object' && ((base + (fieldOf(m, ['zip_path', 'path']) || '').replace(/^\.?\//, '')) === item.ref || `${base}${fieldOf(m, ['patient_id'])}/${fieldOf(m, ['saved_filename'])}` === item.ref)) || {};
  } catch { meta = {}; }
  const saved = item.ref.split('/').pop();
  const original = fieldOf(meta, ['original_filename']) || item.display_name || saved;
  const [aid] = await knex('patient_attachments').insert({
    business_id: business, patient_id: pid, legacy_patient_ref: lp ? lp.id : null, legacy_source: SOURCE, legacy_patient_id: item.legacy_patient_id,
    legacy_patient_number: item.legacy_patient_number || (lp && lp.legacy_patient_number) || null,
    original_filename: clip(original, 255), stored_filename: clip(saved, 255), mime_type: item.mime || files.typeOf(saved, buf) || 'application/octet-stream',
    category: files.categoryOf(saved) !== 'other' ? files.categoryOf(saved) : files.categoryOf(original), file_size: buf.length,
    stored_bytes: copy ? 0 : buf.length, storage_path: storagePath, checksum: sha, duplicate_of: copy ? copy.id : null,
    source_url: clip(fieldOf(meta, ['source_url', 'url']), 1000), zip_path: clip(item.ref, 500), import_batch_id: batch.id, import_job_id: job.id,
  }).onConflict(['business_id', 'legacy_patient_id', 'checksum']).ignore();
  const row = aid ? { id: aid } : await knex('patient_attachments').where({ business_id: business, legacy_patient_id: item.legacy_patient_id, checksum: sha }).first('id');
  await knex('import_items').where({ id: item.id }).update({ status: copy ? 'duplicate' : 'imported', target_id: row.id, match: pid ? 'matched' : 'unmatched', message: copy ? 'SAME_FILE_STORED_ONCE' : null, updated_at: now() });
  return copy ? 'duplicate' : 'imported';
}

// ================================================================= the runner
const busy = new Set(); // businessId (this process)
const runs = new Map();
const again = new Set();

/** Runs a clinic's open job in the background (no-op when it already runs here). */
function kick(businessId) {
  if (busy.has(businessId)) { again.add(businessId); return runs.get(businessId); }
  busy.add(businessId);
  const p = tenant.runFor(businessId, () => loop(businessId)).catch((e) => console.error('[legacy-import]', e.message)) // eslint-disable-line no-console
    .finally(() => {
      busy.delete(businessId);
      // Work added while the runner was finishing (another upload) gets its own round.
      if (again.delete(businessId)) return kick(businessId);
      return null;
    });
  runs.set(businessId, p);
  return p;
}
/** Resolves when the clinic's runner is idle (tests, shutdown). */
const settle = (businessId) => runs.get(businessId) || Promise.resolve();

// Which process runs a job: this one (RUNNER) while it keeps the heartbeat fresh; a job whose runner went quiet
// (server stopped, crashed) is taken over by the next process that looks at it.
const RUNNER = `${require('os').hostname().slice(0, 20)}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`; // eslint-disable-line global-require
async function claim(job) {
  const stale = new Date(Date.now() - STALE_MS);
  const n = await knex('import_jobs').where({ id: job.id })
    .where((w) => w.whereNull('runner').orWhere('runner', RUNNER).orWhereNull('heartbeat_at').orWhere('heartbeat_at', '<', stale))
    .update({ runner: RUNNER, heartbeat_at: now() });
  return n > 0;
}
const release = (jobId) => knex('import_jobs').where({ id: jobId, runner: RUNNER }).update({ runner: null });

async function loop(businessId) {
  for (;;) {
    const job = await currentJob(businessId); // eslint-disable-line no-await-in-loop
    if (!job || !['analyzing', 'processing'].includes(job.status)) return;
    if (!(await claim(job))) return; // eslint-disable-line no-await-in-loop -- another process runs it
    let more = false;
    try { more = job.status === 'analyzing' ? await analyzeRound(job) : await importRound(job); } // eslint-disable-line no-await-in-loop
    finally { if (!more) await release(job.id); } // eslint-disable-line no-await-in-loop
    if (!more) return;
  }
}

async function analyzeRound(job) {
  const b = await knex('import_batches').where({ job_id: job.id }).whereIn('status', ['uploaded', 'analyzing']).orderByRaw("FIELD(kind, 'patients_json', 'attachments_zip')").orderBy('id').first();
  if (!b) {
    await refreshTotals(job.id);
    await knex('import_jobs').where({ id: job.id, status: 'analyzing' }).update({ status: 'ready', stage: null, heartbeat_at: null });
    return false;
  }
  try {
    if (b.kind === 'patients_json') await analyzePatients(job, b); else await analyzeZip(job, b);
  } catch (e) {
    await knex('import_batches').where({ id: b.id }).update({ status: 'invalid', error: clip(e.message, 255) });
    await logError(job, { batch: b.id, file: b.original_name, stage: b.kind === 'patients_json' ? 'patients_analysis' : 'zip_analysis', code: e.code || 'ANALYSIS_FAILED', message: e.message });
  }
  // A patients file read after the ZIPs: the files' patients are tied again when imported (nothing to redo here).
  return true;
}

async function importRound(job) {
  // Items left half-done by a stopped run start again (their transaction did not commit).
  await knex('import_items').where({ job_id: job.id, status: 'processing' }).update({ status: 'pending' });
  const kind = job.stage === 'attachments_import' ? 'attachment' : 'patient';
  const items = await knex('import_items').where({ job_id: job.id, kind, status: 'pending' }).orderBy('id').limit(STEP);
  if (!items.length) {
    if (kind === 'patient') { await knex('import_jobs').where({ id: job.id }).update({ stage: 'attachments_import' }); return true; }
    await reconcile(job);
    return false;
  }
  const batches = await knex('import_batches').where({ job_id: job.id });
  const pjson = batches.find((b) => b.kind === 'patients_json' && b.status === 'valid');
  const index = kind === 'patient' ? await readIndex(job) : null;
  const zips = new Map(batches.filter((b) => b.kind === 'attachments_zip' && b.stored_path && fs.existsSync(b.stored_path)).map((b) => [b.id, b]));
  zips.reader = new Map(); zips.manifests = new Map();
  let ok = 0; let bad = 0; let skip = 0;
  try {
    for (const item of items) { // eslint-disable-line no-restricted-syntax
      await knex('import_items').where({ id: item.id }).update({ status: 'processing', attempts: item.attempts + 1 }); // eslint-disable-line no-await-in-loop
      try {
        if (kind === 'patient') {
          if (!pjson || !pjson.stored_path || !fs.existsSync(pjson.stored_path)) throw fail('SOURCE_GONE', 'The patients file is no longer on the server; upload it again.');
          await importPatient(job, item, index, pjson.stored_path); // eslint-disable-line no-await-in-loop
          ok += 1;
        } else {
          const r = await importAttachment(job, item, zips); // eslint-disable-line no-await-in-loop
          if (r === 'duplicate') skip += 1; else ok += 1;
        }
      } catch (e) {
        if (e.code === 'STORAGE_FULL') {
          await knex('import_items').where({ id: item.id }).update({ status: 'pending' }); // eslint-disable-line no-await-in-loop
          await knex('import_jobs').where({ id: job.id }).update({ status: 'failed', error: 'STORAGE_FULL', heartbeat_at: null }); // eslint-disable-line no-await-in-loop
          await logError(job, { item: item.id, legacyId: item.legacy_patient_id, file: kind === 'attachment' ? item.ref : null, stage: `${kind}s_import`.replace('patients_import', 'patients_import'), code: 'STORAGE_FULL', message: "The clinic's file storage is full; raise it, then resume." }); // eslint-disable-line no-await-in-loop
          return false;
        }
        bad += 1;
        await knex('import_items').where({ id: item.id }).update({ status: 'failed', message: clip(e.code || 'FAILED', 255), updated_at: now() }); // eslint-disable-line no-await-in-loop
        await logError(job, { item: item.id, legacyId: item.legacy_patient_id, file: kind === 'attachment' ? item.ref : null, stage: kind === 'patient' ? 'patient_import' : 'attachment_import', code: e.code || 'IMPORT_FAILED', message: e.message }); // eslint-disable-line no-await-in-loop
      }
    }
  } finally { for (const z of zips.reader.values()) z.close(); }
  await knex('import_jobs').where({ id: job.id }).update({
    processed: knex.raw('processed + ?', [items.length]), success: knex.raw('success + ?', [ok]), failed: knex.raw('failed + ?', [bad]), skipped: knex.raw('skipped + ?', [skip]), heartbeat_at: now(),
  });
  return true;
}

/** Compares the source with what the system now holds; the job ends completed only when nothing differs. */
async function reconcile(job) {
  await knex('import_jobs').where({ id: job.id }).update({ stage: 'reconcile' });
  const ids = knex('import_items').where({ job_id: job.id, kind: 'patient' }).select('legacy_patient_id');
  const refs = knex('legacy_patients').where({ business_id: job.business_id, legacy_source: SOURCE }).whereIn('legacy_patient_id', ids).select('id');
  const [[pa], [tr], [cl], [at]] = await Promise.all([
    knex('legacy_patients').where({ business_id: job.business_id, legacy_source: SOURCE }).whereIn('legacy_patient_id', ids).count({ n: '*' }),
    knex('legacy_treatments').whereIn('legacy_patient_ref', refs).count({ n: '*' }),
    knex('legacy_clinical_records').whereIn('legacy_patient_ref', refs).count({ n: '*' }),
    knex('import_items').where({ job_id: job.id, kind: 'attachment' }).whereIn('status', ['imported', 'duplicate']).count({ n: '*' }),
  ]);
  const fresh = await knex('import_jobs').where({ id: job.id }).first();
  const sys = { sys_patients: Number(pa.n), sys_treatments: Number(tr.n), sys_clinical: Number(cl.n), sys_attachments: Number(at.n) };
  const [[openErr]] = await Promise.all([knex('import_errors').where({ job_id: job.id, level: 'error', status: 'open' }).count({ n: '*' })]);
  const clean = sys.sys_patients === fresh.src_patients && sys.sys_treatments >= fresh.src_treatments && sys.sys_clinical >= fresh.src_clinical
    && sys.sys_attachments === fresh.src_attachments && Number(openErr.n) === 0;
  await knex('import_jobs').where({ id: job.id }).update({ ...sys, status: clean ? 'completed' : 'completed_with_issues', stage: null, completed_at: now(), heartbeat_at: null });
  await audit.record({ businessId: job.business_id, userId: job.created_by }, 'legacy.import_completed', { entityType: 'import_job', entityId: job.id, newValues: { ...sys, status: clean ? 'completed' : 'completed_with_issues' } });
  // The uploads are no longer needed once everything is in (kept while something can still be retried).
  if (clean) {
    fs.rmSync(jobDir(job.business_id, job.id), { recursive: true, force: true });
    await knex('import_batches').where({ job_id: job.id }).update({ stored_path: null });
  }
}

/** Reconciliation rows for the report: what the source held, what the system holds, the difference. */
function reconciliation(job) {
  const row = (k, src, sys) => ({ key: k, source: src, system: sys === null ? null : sys, difference: sys === null ? null : sys - src });
  return [row('patients', job.src_patients, job.sys_patients), row('treatments', job.src_treatments, job.sys_treatments),
    row('clinical', job.src_clinical, job.sys_clinical), row('attachments', job.src_attachments, job.sys_attachments)];
}

// ================================================================= errors: retry / ignore
async function retryError(ctx, jobId, errorId) {
  const job = await getJob(ctx.businessId, jobId);
  const err = await knex('import_errors').where({ id: Number(errorId), job_id: job.id }).first();
  if (!err) throw E.notFound('Error');
  if (err.item_id) {
    const item = await knex('import_items').where({ id: err.item_id, job_id: job.id }).first();
    if (item && ['failed', 'skipped'].includes(item.status)) {
      await knex('import_items').where({ id: item.id }).update({ status: 'pending', message: null });
      if (['completed', 'completed_with_issues', 'failed'].includes(job.status)) await knex('import_jobs').where({ id: job.id }).update({ status: 'processing', stage: item.kind === 'patient' ? 'patients_import' : 'attachments_import', completed_at: null, error: null, heartbeat_at: null });
    }
  } else if (job.status === 'failed' && job.error === 'STORAGE_FULL') {
    await knex('import_jobs').where({ id: job.id }).update({ status: 'processing', error: null, heartbeat_at: null });
  }
  await knex('import_errors').where({ id: err.id }).update({ status: 'resolved' });
  await audit.record(ctx, 'legacy.import_retry', { entityType: 'import_job', entityId: job.id, newValues: { error: err.id, code: err.error_code } });
  kick(ctx.businessId);
}
async function ignoreError(ctx, jobId, errorId) {
  const job = await getJob(ctx.businessId, jobId);
  const err = await knex('import_errors').where({ id: Number(errorId), job_id: job.id }).first();
  if (!err) throw E.notFound('Error');
  await knex('import_errors').where({ id: err.id }).update({ status: 'ignored' });
  if (err.item_id) await knex('import_items').where({ id: err.item_id, job_id: job.id, status: 'failed' }).update({ status: 'skipped' });
  await audit.record(ctx, 'legacy.import_error_ignored', { entityType: 'import_job', entityId: job.id, newValues: { error: err.id, code: err.error_code } });
}
/** Resumes a job stopped by a failure (storage full, server stop) from its next pending item. */
async function resume(ctx, jobId) {
  const job = await getJob(ctx.businessId, jobId);
  if (!['failed', 'processing'].includes(job.status)) return;
  await knex('import_jobs').where({ id: job.id }).update({ status: 'processing', error: null, heartbeat_at: null });
  await audit.record(ctx, 'legacy.import_resumed', { entityType: 'import_job', entityId: job.id });
  kick(ctx.businessId);
}

// ================================================================= recovery: linking an old patient by hand
async function linkPatient(ctx, legacyRef, patientId) {
  const lp = await knex('legacy_patients').where({ id: Number(legacyRef), business_id: ctx.businessId }).first();
  if (!lp) throw E.notFound('Legacy patient');
  const p = await knex('patients').where({ id: Number(patientId), business_id: ctx.businessId }).first('id', 'legacy_patient_id', 'legacy_source');
  if (!p) throw E.validation({ patient_id: 'Choose a valid value.' });
  if (p.legacy_patient_id && !(p.legacy_source === SOURCE && p.legacy_patient_id === lp.legacy_patient_id)) throw fail('LEGACY_ALREADY_LINKED', 'This patient is already linked to another old file.', 409);
  if (lp.patient_id && lp.patient_id !== p.id) throw fail('LEGACY_ALREADY_LINKED', 'This old file is already linked to another patient.', 409);
  await knex.transaction((trx) => linkRows(trx, ctx.businessId, lp.id, lp.legacy_patient_id, p.id, lp.import_job_id, lp.legacy_patient_number));
  await knex('import_items').where({ business_id: ctx.businessId, kind: 'patient', legacy_patient_id: lp.legacy_patient_id }).whereIn('status', ['unmatched']).update({ status: 'imported', match: 'matched', target_id: p.id });
  await audit.record(ctx, 'legacy.patient_linked', { entityType: 'patient', entityId: p.id, newValues: { legacy_source: SOURCE, legacy_patient_id: lp.legacy_patient_id, legacy_patient_number: lp.legacy_patient_number } });
  return p.id;
}

/** A new patient file from an old one (its name and mobile), linked to it. */
async function createFromLegacy(ctx, legacyRef) {
  const lp = await knex('legacy_patients').where({ id: Number(legacyRef), business_id: ctx.businessId }).first();
  if (!lp) throw E.notFound('Legacy patient');
  if (lp.patient_id) return lp.patient_id;
  const phone = lp.old_mobile ? String(lp.old_mobile).replace(/[^\d+]/g, '').slice(0, 40) : null;
  if (phone && await knex('patients').where({ business_id: ctx.businessId, phone }).first('id')) throw fail('PATIENT_PHONE_TAKEN', 'Another patient already uses this phone number; link the old file to that patient instead.', 409);
  const [pid] = await knex('patients').insert({ business_id: ctx.businessId, full_name: lp.old_name || `#${lp.legacy_patient_id}`, phone, email: lp.email || null });
  await knex.transaction((trx) => linkRows(trx, ctx.businessId, lp.id, lp.legacy_patient_id, pid, lp.import_job_id, lp.legacy_patient_number));
  await knex('import_items').where({ business_id: ctx.businessId, kind: 'patient', legacy_patient_id: lp.legacy_patient_id }).whereIn('status', ['unmatched']).update({ status: 'imported', match: 'new', target_id: pid });
  await audit.record(ctx, 'legacy.patient_recovered', { entityType: 'patient', entityId: pid, newValues: { legacy_source: SOURCE, legacy_patient_id: lp.legacy_patient_id } });
  return pid;
}

// ================================================================= report
async function report(businessId, jobId) {
  const s = await summary(businessId, jobId);
  const [items, errors] = await Promise.all([
    knex('import_items').where({ job_id: s.job.id }).orderBy([{ column: 'kind', order: 'desc' }, { column: 'id' }])
      .select('kind', 'ref', 'legacy_patient_id', 'legacy_patient_number', 'display_name', 'match', 'status', 'target_id', 'treatments', 'clinical', 'size', 'mime', 'message'),
    knex('import_errors').where({ job_id: s.job.id }).orderBy('id').select('legacy_patient_id', 'file', 'stage', 'error_code', 'message', 'level', 'status', 'created_at'),
  ]);
  return { summary: s, reconciliation: reconciliation(s.job), items, errors };
}

/** At start: every clinic's job left running (server restart) continues where it stopped. */
async function resumeAll() {
  await tenant.eachDb(async () => {
    const open = await knex('import_jobs').where({ type: TYPE }).whereIn('status', ['analyzing', 'processing']).select('business_id').catch(() => []);
    [...new Set(open.map((j) => j.business_id))].forEach((id) => kick(id));
  });
}

module.exports = {
  SOURCE, TYPE, ROOT, jobDir, openJob, rematchJob, candidate, normPhone, normFile, getJob, currentJob, jobs, addUpload, removeBatch, summary, counts, start, cancel, resume, retryError, ignoreError,
  linkPatient, createFromLegacy, report, reconciliation, resumeAll, kick, settle, manifestEntries,
};
