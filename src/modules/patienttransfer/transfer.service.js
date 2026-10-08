// Moving or sharing patients between the clinics of one owner (e.g. a doctor's clinic in Khalidi and the one in
// Abdali), each clinic possibly in its own database. A patient's whole file is copied — the details, every visit with
// its notes, diagnoses, prescriptions, tests, referrals, dental chart, growth, pregnancies, surgeries, specialty
// forms, the stored files, the invoice / certificate papers, and what came from a previous system (legacy records and
// files) — with the same engine as a DocBook patient export / import (patientexport), straight from one clinic's
// database to the other's: nothing is written to disk on the way, nothing leaves the server.
//
//   move   the patient continues in the other clinic; here the file stays as a read-only archive (hidden from the
//          patient list, with where it went), which the owner can bring back.
//   share  the patient is a patient of both clinics (visits here or there); the two files are linked and either
//          clinic can pull what the other added since ("update from …").
//   sync   that update: only what is new on the other side comes over.
// Rules: only someone who manages the data (data.manage) of BOTH clinics may do it; a patient already in the other
// clinic (linked before, the national ID, or the same name and phone) is completed, never duplicated; copying again
// adds nothing twice (import_links, both ways); invoices are never re-created (their PDF goes to the patient's files);
// upcoming bookings stay where they were booked (the report says how many). Every transfer is audited in both clinics.
const crypto = require('crypto');
const knex = require('../../db/knex');
const tenant = require('../../db/tenant');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const rbac = require('../rbac/rbac.service');
const exporter = require('../patientexport/export.service');
const importer = require('../patientexport/import.service');
const storage = require('../storage/storage.service');
const files = require('../legacy/files');
const { clinicNow } = require('../clinic/scheduling');

const MODES = ['move', 'share', 'sync'];
const MAX = 5000; // patients per transfer
const STALE_MS = 2 * 60_000;
const RUNNER = `${require('os').hostname().slice(0, 20)}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`; // eslint-disable-line global-require
const fail = (code, message, status = 422) => new AppError(code, message, status);
const now = () => new Date();
const clip = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

// ================================================================= who may, and where to
const canManage = async (businessId, userId) => (await rbac.getUserPermissions(businessId, userId)).has('data.manage');

/** The other clinics of this member where they manage the data (the possible destinations). */
async function targets(ctx) {
  const rows = await knex('memberships as m').join('businesses as b', 'b.id', 'm.business_id')
    .where({ 'm.user_id': ctx.userId, 'm.status': 'active' }).whereNot('m.business_id', ctx.businessId).where((w) => w.whereNull('b.kind').orWhereNot('b.kind', 'center_admin'))
    .orderBy('b.name').select('b.id', 'b.name', 'b.name_en', 'b.timezone', 'b.status');
  const out = [];
  for (const b of rows) if (b.status !== 'suspended' && await canManage(b.id, ctx.userId)) out.push(b); // eslint-disable-line no-restricted-syntax, no-await-in-loop
  return out;
}
async function assertTarget(ctx, toId) {
  const t = (await targets(ctx)).find((b) => b.id === Number(toId));
  if (!t) throw fail('TRANSFER_TARGET', 'Choose one of your other clinics.');
  return t;
}

/** The receiving clinic's doctors (read in its own database). */
const doctorsOf = (businessId) => tenant.runFor(businessId, () => knex('doctors').where({ business_id: businessId }).orderBy('full_name').select('id', 'full_name', 'full_name_en'));

// ================================================================= starting
/**
 * Queues a transfer of these patients of the clinic (ctx) to another clinic of the member.
 * @param {{ to, patientIds, mode, defaultDoctorId }} input
 */
async function start(ctx, { to, patientIds, mode, defaultDoctorId = null }) {
  if (!['move', 'share'].includes(mode)) throw fail('TRANSFER_MODE', 'Choose move or share.');
  if (!(await canManage(ctx.businessId, ctx.userId))) throw E.forbidden('data.manage');
  const target = await assertTarget(ctx, to);
  const ids = [...new Set((patientIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw fail('TRANSFER_EMPTY', 'Choose at least one patient.');
  if (ids.length > MAX) throw fail('TRANSFER_TOO_MANY', `At most ${MAX} patients at once.`);
  const pats = await knex('patients').where({ business_id: ctx.businessId }).whereIn('id', ids).whereNull('transferred_at').select('id', 'full_name');
  if (!pats.length) throw fail('TRANSFER_EMPTY', 'Choose at least one patient.');
  let doctor = null;
  if (defaultDoctorId) doctor = (await doctorsOf(target.id)).find((d) => d.id === Number(defaultDoctorId)) || null;
  return queue(ctx, { from: ctx.businessId, to: target.id, mode, doctor: doctor ? doctor.id : null, pats });
}

async function queue(ctx, { from, to, mode, doctor, pats }) {
  const [id] = await knex('patient_transfers').insert({ user_id: ctx.userId, from_business_id: from, to_business_id: to, mode, default_doctor_id: doctor, total: pats.length, locale: ctx.locale || 'ar' });
  for (let i = 0; i < pats.length; i += 500) {
    await knex('patient_transfer_items').insert(pats.slice(i, i + 500).map((p) => ({ transfer_id: id, src_patient_id: p.id, name: clip(p.full_name, 190) }))); // eslint-disable-line no-await-in-loop
  }
  const note = { transfer: id, mode, from, to, patients: pats.length };
  await tenant.runFor(from, () => audit.record({ ...ctx, businessId: from }, `patients.transfer_${mode}`, { entityType: 'patient_transfer', entityId: id, newValues: note }));
  if (to !== from) await tenant.runFor(to, () => audit.record({ ...ctx, businessId: to }, `patients.transfer_${mode}_in`, { entityType: 'patient_transfer', entityId: id, newValues: note }));
  kick();
  return id;
}

/** "Update from the other clinic": pulls what is new there for these shared patients of this clinic. */
async function sync(ctx, { other, patientIds = null }) {
  if (!(await canManage(ctx.businessId, ctx.userId))) throw E.forbidden('data.manage');
  await assertTarget(ctx, other);
  const q = knex('patient_links').where({ business_id: ctx.businessId, other_business_id: Number(other), kind: 'shared' });
  if (patientIds) q.whereIn('patient_id', patientIds.map(Number));
  const links = await q.select('other_patient_id');
  if (!links.length) throw fail('TRANSFER_EMPTY', 'No shared patients with this clinic.');
  const names = await tenant.runFor(Number(other), () => knex('patients').where({ business_id: Number(other) }).whereIn('id', links.map((l) => l.other_patient_id)).select('id', 'full_name'));
  if (!names.length) throw fail('TRANSFER_EMPTY', 'No shared patients with this clinic.');
  return queue(ctx, { from: Number(other), to: ctx.businessId, mode: 'sync', doctor: null, pats: names });
}

// ================================================================= one patient
/** The patient's file in the source clinic as an in-memory archive (what an export would hold, minus the PDFs). */
async function readSource(srcCtx, patientId) {
  const entries = new Map();
  const r = await exporter.collect(srcCtx, patientId, srcCtx.locale, (name, buf) => { entries.set(name, Buffer.from(buf)); }, { transfer: true });
  const zip = { read: (n) => entries.get(n) || null, sizeOf: (n) => (entries.has(n) ? entries.get(n).length : null), has: (n) => entries.has(n), names: () => [...entries.keys()] };
  return { zip, patient: r.patient };
}

/** The previous system's records and files of the patient (legacy import), read in the source clinic. */
async function readLegacy(from, srcPid) {
  const lps = await knex('legacy_patients').where({ business_id: from, patient_id: srcPid });
  const out = [];
  for (const lp of lps) { // eslint-disable-line no-restricted-syntax
    const [links, fields, treatments, records] = await Promise.all([ // eslint-disable-line no-await-in-loop
      knex('legacy_patient_links').where({ legacy_patient_ref: lp.id }).orderBy('id'),
      knex('legacy_field_values').where({ owner_type: 'patient', owner_id: lp.id }).orderBy('position'),
      knex('legacy_treatments').where({ legacy_patient_ref: lp.id }).orderBy('id'),
      knex('legacy_clinical_records').where({ legacy_patient_ref: lp.id }).orderBy('id'),
    ]);
    const tf = treatments.length ? await knex('legacy_field_values').where({ owner_type: 'treatment' }).whereIn('owner_id', treatments.map((t) => t.id)).orderBy('position') : []; // eslint-disable-line no-await-in-loop
    const cv = records.length ? await knex('legacy_clinical_values').whereIn('record_id', records.map((r) => r.id)).orderBy('position') : []; // eslint-disable-line no-await-in-loop
    out.push({ lp, links, fields, treatments: treatments.map((t) => ({ t, extra: tf.filter((f) => f.owner_id === t.id) })), records: records.map((r) => ({ r, values: cv.filter((v) => v.record_id === r.id) })) });
  }
  const atts = await knex('patient_attachments').where({ business_id: from, patient_id: srcPid }).orderBy('id');
  const attachments = atts.filter((a) => files.exists(a.storage_path)).map((a) => ({ a, buf: files.read(a.storage_path) }));
  return { legacy: out, attachments };
}

const strip = (row, drop = []) => { const o = { ...row }; ['id', 'business_id', 'created_at', 'updated_at', ...drop].forEach((k) => { delete o[k]; }); return o; };

/** Writes them in the receiving clinic (each part keyed, so a second copy adds nothing). → bytes stored */
async function writeLegacy(to, dstPid, { legacy, attachments }, key = null) {
  let stored = 0;
  await knex.transaction(async (trx) => {
    for (const { lp, links, fields, treatments, records } of legacy) { // eslint-disable-line no-restricted-syntax
      const have = await trx('legacy_patients').where({ business_id: to, legacy_source: lp.legacy_source, legacy_patient_id: lp.legacy_patient_id }).first('id', 'patient_id'); // eslint-disable-line no-await-in-loop
      let ref;
      if (have) { ref = have.id; if (!have.patient_id) await trx('legacy_patients').where({ id: ref }).update({ patient_id: dstPid }); } // eslint-disable-line no-await-in-loop
      else [ref] = await trx('legacy_patients').insert({ ...strip(lp, ['import_job_id']), business_id: to, patient_id: dstPid, import_job_id: null }); // eslint-disable-line no-await-in-loop
      if (!have) {
        if (links.length) await trx('legacy_patient_links').insert(links.map((l) => ({ ...strip(l, ['legacy_patient_ref']), business_id: to, legacy_patient_ref: ref }))); // eslint-disable-line no-await-in-loop
        if (fields.length) await trx('legacy_field_values').insert(fields.map((f) => ({ ...strip(f, ['owner_id']), business_id: to, owner_id: ref }))); // eslint-disable-line no-await-in-loop
      }
      const keys = new Set(await trx('legacy_treatments').where({ legacy_patient_ref: ref }).pluck('row_key')); // eslint-disable-line no-await-in-loop
      for (const { t, extra } of treatments) { // eslint-disable-line no-restricted-syntax
        if (keys.has(t.row_key)) continue; // eslint-disable-line no-continue
        // Its treatment-plan item came over with the patient's file (dental_plan): the copy here is its plan item.
        const planLink = key && t.plan_item_id ? await trx('import_links').where({ business_id: to, source_key: key, kind: 'dental_plan', src_id: t.plan_item_id }).first('new_id') : null; // eslint-disable-line no-await-in-loop
        const [tid] = await trx('legacy_treatments').insert({ ...strip(t, ['legacy_patient_ref', 'patient_id', 'import_job_id', 'plan_item_id', 'doctor_id']), business_id: to, legacy_patient_ref: ref, patient_id: dstPid, import_job_id: null, plan_item_id: planLink ? planLink.new_id : null }); // eslint-disable-line no-await-in-loop
        if (planLink) await trx('dental_plan_items').where({ id: planLink.new_id, business_id: to }).update({ legacy_treatment_id: tid }); // eslint-disable-line no-await-in-loop
        if (extra.length) await trx('legacy_field_values').insert(extra.map((f) => ({ ...strip(f, ['owner_id']), business_id: to, owner_id: tid }))); // eslint-disable-line no-await-in-loop
      }
      const rkeys = new Set((await trx('legacy_clinical_records').where({ legacy_patient_ref: ref }).select('table_key', 'row_key')).map((r) => `${r.table_key}\u0000${r.row_key}`)); // eslint-disable-line no-await-in-loop
      for (const { r, values } of records) { // eslint-disable-line no-restricted-syntax
        if (rkeys.has(`${r.table_key}\u0000${r.row_key}`)) continue; // eslint-disable-line no-continue
        const [rid] = await trx('legacy_clinical_records').insert({ ...strip(r, ['legacy_patient_ref', 'patient_id', 'import_job_id']), business_id: to, legacy_patient_ref: ref, patient_id: dstPid, import_job_id: null }); // eslint-disable-line no-await-in-loop
        if (values.length) await trx('legacy_clinical_values').insert(values.map((v) => ({ ...strip(v, ['record_id']), business_id: to, record_id: rid }))); // eslint-disable-line no-await-in-loop
      }
    }
    const fresh = [];
    for (const x of attachments) { // eslint-disable-line no-restricted-syntax
      if (await trx('patient_attachments').where({ business_id: to, legacy_patient_id: x.a.legacy_patient_id, checksum: x.a.checksum }).first('id')) continue; // eslint-disable-line no-await-in-loop, no-continue
      fresh.push(x);
    }
    const newBytes = [];
    for (const x of fresh) { // eslint-disable-line no-restricted-syntax
      const copy = await trx('patient_attachments').where({ business_id: to, checksum: x.a.checksum }).whereNull('duplicate_of').first('id', 'storage_path'); // eslint-disable-line no-await-in-loop
      x.copy = copy && files.exists(copy.storage_path) ? copy : null;
      if (!x.copy) newBytes.push(x.buf.length);
    }
    const bytes = newBytes.reduce((a, b) => a + b, 0);
    if (bytes) await storage.assertRoom(to, bytes);
    for (const x of fresh) { // eslint-disable-line no-restricted-syntax
      const lp = await trx('legacy_patients').where({ business_id: to, legacy_source: x.a.legacy_source, legacy_patient_id: x.a.legacy_patient_id }).first('id'); // eslint-disable-line no-await-in-loop
      const path = x.copy ? x.copy.storage_path : files.put(to, x.a.checksum, x.buf);
      await trx('patient_attachments').insert({ // eslint-disable-line no-await-in-loop
        ...strip(x.a, ['patient_id', 'legacy_patient_ref', 'storage_path', 'duplicate_of', 'stored_bytes', 'import_batch_id', 'import_job_id', 'uploaded_by']),
        business_id: to, patient_id: dstPid, legacy_patient_ref: lp ? lp.id : null, storage_path: path, duplicate_of: x.copy ? x.copy.id : null,
        stored_bytes: x.copy ? 0 : x.buf.length, import_batch_id: null, import_job_id: null, uploaded_by: null,
      }).onConflict(['business_id', 'legacy_patient_id', 'checksum']).ignore();
      if (!x.copy) stored += x.buf.length;
    }
    // The patient here carries the old system's id too (when nobody else has it).
    const lp0 = legacy[0] && legacy[0].lp;
    if (lp0) {
      const taken = await trx('patients').where({ business_id: to, legacy_source: lp0.legacy_source, legacy_patient_id: lp0.legacy_patient_id }).whereNot('id', dstPid).first('id');
      if (!taken) await trx('patients').where({ id: dstPid, business_id: to }).whereNull('legacy_patient_id').update({ legacy_source: lp0.legacy_source, legacy_patient_id: lp0.legacy_patient_id, legacy_patient_number: lp0.legacy_patient_number, legacy_imported_at: lp0.imported_at || now() });
    }
  });
  return stored;
}

/**
 * After a copy S → T: what T now holds of S is told to S too (S's record ↔ T's copy, in S's import_links under T's
 * key), so a later copy T → S (an update the other way) recognises S's own records and brings only what is new.
 */
async function mirrorLinks(from, to, keyFrom, keyTo, dstPid) {
  const pairs = await tenant.runFor(to, async () => {
    const out = [];
    for (const [kind, table] of Object.entries(importer.TABLES)) { // eslint-disable-line no-restricted-syntax
      if (kind.startsWith('paper_')) continue; // eslint-disable-line no-continue
      const q = knex('import_links as l').join(`${table} as x`, 'x.id', 'l.new_id').where({ 'l.business_id': to, 'l.source_key': keyFrom, 'l.kind': kind });
      if (kind === 'patient') q.where('x.id', dstPid); else q.where('x.patient_id', dstPid);
      (await q.select('l.src_id', 'l.new_id')).forEach((r) => out.push([kind, r.src_id, r.new_id])); // eslint-disable-line no-await-in-loop
    }
    return out;
  });
  if (!pairs.length) return;
  await tenant.runFor(from, async () => {
    for (let i = 0; i < pairs.length; i += 500) {
      await knex('import_links').insert(pairs.slice(i, i + 500).map(([kind, srcId, newId]) => ({ business_id: from, source_key: keyTo, kind, src_id: newId, new_id: srcId }))) // eslint-disable-line no-await-in-loop
        .onConflict(['business_id', 'source_key', 'kind', 'src_id']).merge();
    }
  });
}

async function keyOf(businessId) { return `${await exporter.instanceId()}:${Number(businessId)}`.slice(0, 80); }

async function setLink(businessId, patientId, otherBusinessId, otherPatientId, kind, transferId) {
  await knex('patient_links').insert({ business_id: businessId, patient_id: patientId, other_business_id: otherBusinessId, other_patient_id: otherPatientId, kind, transfer_id: transferId, last_synced_at: now() })
    .onConflict(['business_id', 'patient_id', 'other_business_id']).merge({ other_patient_id: otherPatientId, kind, transfer_id: transferId, last_synced_at: now(), updated_at: now() });
}

/** Copies one patient S → T; returns { dstPid, future, rep }. */
async function transferOne(job, item, ctxs, rep) {
  const { from, to } = { from: job.from_business_id, to: job.to_business_id };
  const src = await tenant.runFor(from, async () => {
    const p = await knex('patients').where({ id: item.src_patient_id, business_id: from }).first('id', 'transferred_at');
    if (!p) throw fail('TRANSFER_GONE', 'The patient is no longer in the clinic.');
    if (p.transferred_at && job.mode !== 'sync') throw fail('TRANSFER_ALREADY_MOVED', 'The patient has already moved to another clinic.');
    const read = await readSource(ctxs.src, item.src_patient_id);
    const legacy = await readLegacy(from, item.src_patient_id);
    const groups = await knex('patient_group_members as m').join('patient_groups as g', 'g.id', 'm.group_id').where({ 'm.business_id': from, 'm.patient_id': item.src_patient_id }).pluck('g.name');
    const photo = await knex('patient_photos').where({ business_id: from, patient_id: item.src_patient_id }).first();
    return { ...read, legacy, groups, photo };
  });
  const d = importer.readData(src.zip, '');
  const key = importer.sourceKey(d);
  const today = ctxs.dst.today;
  const future = d.appointments.filter((a) => String(a.appointment_date) >= today && ['pending', 'confirmed'].includes(a.status)).length;
  const dstPid = await tenant.runFor(to, async () => {
    // The receiving clinic's doctor for each doctor of the file: the same name there, else the one chosen.
    const plan = { doctors: {} };
    for (const doc of d.doctors) plan.doctors[`${key}:${doc.id}`] = (await importer.matchDoctor(ctxs.dst, doc, false)) || job.default_doctor_id || null; // eslint-disable-line no-restricted-syntax, no-await-in-loop
    const pid = await importer.importOne(ctxs.dst, src.zip, '', plan, rep, ctxs.inst, ctxs.t);
    rep.legacy_bytes = (rep.legacy_bytes || 0) + await writeLegacy(to, pid, src.legacy, key);
    // Its groups (by name) and its photo (when it has none here).
    for (const name of src.groups) { // eslint-disable-line no-restricted-syntax
      await knex('patient_groups').insert({ business_id: to, name }).onConflict(['business_id', 'name']).ignore(); // eslint-disable-line no-await-in-loop
      const g = await knex('patient_groups').where({ business_id: to, name }).first('id'); // eslint-disable-line no-await-in-loop
      await knex('patient_group_members').insert({ business_id: to, patient_id: pid, group_id: g.id }).onConflict(['patient_id', 'group_id']).ignore(); // eslint-disable-line no-await-in-loop
    }
    if (src.photo && !(await knex('patient_photos').where({ patient_id: pid }).first('patient_id'))) {
      await knex('patient_photos').insert({ ...strip(src.photo, ['patient_id']), business_id: to, patient_id: pid });
    }
    // Here it is an active patient (it may have been moved away from here before, and now comes back).
    await knex('patients').where({ id: pid, business_id: to }).update({ transferred_to_business_id: null, transferred_patient_id: null, transferred_at: null });
    return pid;
  });
  await mirrorLinks(from, to, key, await keyOf(to), dstPid);
  if (job.mode === 'move') {
    await tenant.runFor(from, () => knex('patients').where({ id: item.src_patient_id, business_id: from }).update({ transferred_to_business_id: to, transferred_patient_id: dstPid, transferred_at: now() }));
    await setLink(from, item.src_patient_id, to, dstPid, 'moved_to', job.id);
    await setLink(to, dstPid, from, item.src_patient_id, 'moved_from', job.id);
  } else {
    await setLink(from, item.src_patient_id, to, dstPid, 'shared', job.id);
    await setLink(to, dstPid, from, item.src_patient_id, 'shared', job.id);
  }
  return { dstPid, future };
}

// ================================================================= the runner (one per process; jobs in turn)
let busy = null;
let again = false;
function kick() {
  if (busy) { again = true; return busy; }
  busy = loop().catch((e) => console.error('[patient-transfer]', e.message)).finally(() => { // eslint-disable-line no-console
    busy = null;
    if (again) { again = false; return kick(); }
    return null;
  });
  return busy;
}
const settle = () => busy || Promise.resolve();

async function claim(job) {
  const stale = new Date(Date.now() - STALE_MS);
  return (await knex('patient_transfers').where({ id: job.id }).where((w) => w.whereNull('runner').orWhere('runner', RUNNER).orWhereNull('heartbeat_at').orWhere('heartbeat_at', '<', stale))
    .update({ runner: RUNNER, heartbeat_at: now(), status: 'running', started_at: job.started_at || now() })) > 0;
}

async function loop() {
  for (;;) {
    const jobs = await knex('patient_transfers').whereIn('status', ['queued', 'running']).orderBy('id').limit(20); // eslint-disable-line no-await-in-loop
    let worked = false;
    for (const job of jobs) { // eslint-disable-line no-restricted-syntax
      if (!(await claim(job))) continue; // eslint-disable-line no-await-in-loop, no-continue
      worked = true;
      await runJob(await knex('patient_transfers').where({ id: job.id }).first()); // eslint-disable-line no-await-in-loop
    }
    if (!worked) return;
  }
}

async function contexts(job) {
  const [srcB, dstB] = await Promise.all([knex('businesses').where({ id: job.from_business_id }).first('timezone'), knex('businesses').where({ id: job.to_business_id }).first('timezone')]);
  const perms = async (b) => (job.user_id ? rbac.getUserPermissions(b, job.user_id) : new Set());
  const locale = job.locale || 'ar';
  return {
    src: { businessId: job.from_business_id, userId: job.user_id, permissions: await perms(job.from_business_id), locale, ownDoctorId: null, today: clinicNow((srcB && srcB.timezone) || 'Asia/Amman').date },
    dst: { businessId: job.to_business_id, userId: job.user_id, permissions: await perms(job.to_business_id), locale, ownDoctorId: null, today: clinicNow((dstB && dstB.timezone) || 'Asia/Amman').date },
    inst: await exporter.instanceId(), t: translator(locale),
  };
}

async function runJob(job) {
  const ctxs = await contexts(job);
  // Still allowed? (a member removed from either clinic in the meantime stops the transfer)
  if (!ctxs.src.permissions.has('data.manage') || !ctxs.dst.permissions.has('data.manage')) {
    await knex('patient_transfers').where({ id: job.id }).update({ status: 'failed', error: 'PERMISSION_DENIED', runner: null, finished_at: now() });
    return;
  }
  await knex('patient_transfer_items').where({ transfer_id: job.id, status: 'processing' }).update({ status: 'pending' });
  const rep = JSON.parse(job.report || '{}');
  for (;;) {
    const items = await knex('patient_transfer_items').where({ transfer_id: job.id, status: 'pending' }).orderBy('id').limit(20); // eslint-disable-line no-await-in-loop
    if (!items.length) break;
    for (const item of items) { // eslint-disable-line no-restricted-syntax
      await knex('patient_transfer_items').where({ id: item.id }).update({ status: 'processing', attempts: item.attempts + 1 }); // eslint-disable-line no-await-in-loop
      try {
        const r = await transferOne(job, item, ctxs, rep); // eslint-disable-line no-await-in-loop
        await knex('patient_transfer_items').where({ id: item.id }).update({ status: 'done', dst_patient_id: r.dstPid, future_bookings: r.future, message: null, updated_at: now() }); // eslint-disable-line no-await-in-loop
        await knex('patient_transfers').where({ id: job.id }).update({ done: knex.raw('done + 1'), heartbeat_at: now(), report: JSON.stringify(rep) }); // eslint-disable-line no-await-in-loop
      } catch (e) {
        if (e.code === 'STORAGE_FULL') {
          await knex('patient_transfer_items').where({ id: item.id }).update({ status: 'pending' }); // eslint-disable-line no-await-in-loop
          await knex('patient_transfers').where({ id: job.id }).update({ status: 'failed', error: 'STORAGE_FULL', runner: null, report: JSON.stringify(rep) }); // eslint-disable-line no-await-in-loop
          return;
        }
        await knex('patient_transfer_items').where({ id: item.id }).update({ status: 'failed', message: clip(`${e.code || 'FAILED'}: ${e.message}`, 255), updated_at: now() }); // eslint-disable-line no-await-in-loop
        await knex('patient_transfers').where({ id: job.id }).update({ failed: knex.raw('failed + 1'), heartbeat_at: now() }); // eslint-disable-line no-await-in-loop
      }
    }
  }
  const fresh = await knex('patient_transfers').where({ id: job.id }).first();
  const status = fresh.failed ? 'done_with_issues' : 'done';
  await knex('patient_transfers').where({ id: job.id }).update({ status, runner: null, finished_at: now(), report: JSON.stringify(rep) });
  const note = { transfer: job.id, status, done: fresh.done, failed: fresh.failed };
  const actor = { userId: job.user_id };
  await tenant.runFor(job.from_business_id, () => audit.record({ ...actor, businessId: job.from_business_id }, 'patients.transfer_finished', { entityType: 'patient_transfer', entityId: job.id, newValues: note }));
  if (job.to_business_id !== job.from_business_id) await tenant.runFor(job.to_business_id, () => audit.record({ ...actor, businessId: job.to_business_id }, 'patients.transfer_finished', { entityType: 'patient_transfer', entityId: job.id, newValues: note }));
}

/** At start (and every few minutes): transfers left by a stopped server carry on. */
async function resumeAll() {
  const open = await knex('patient_transfers').whereIn('status', ['queued', 'running']).first('id').catch(() => null);
  if (open) kick();
}

/** A failed transfer (storage full, server stop) carries on from its next patient; failed patients are tried again. */
async function retry(ctx, id) {
  const job = await getTransfer(ctx, id);
  if (!['failed', 'done_with_issues'].includes(job.status)) return;
  await knex('patient_transfer_items').where({ transfer_id: job.id, status: 'failed' }).update({ status: 'pending' });
  const [{ n }] = await knex('patient_transfer_items').where({ transfer_id: job.id, status: 'failed' }).count({ n: '*' });
  await knex('patient_transfers').where({ id: job.id }).update({ status: 'queued', error: null, runner: null, failed: Number(n), finished_at: null });
  await audit.record(ctx, 'patients.transfer_retried', { entityType: 'patient_transfer', entityId: job.id });
  kick();
}

// ================================================================= reading
/** A transfer this clinic is part of (sent or received). */
async function getTransfer(ctx, id) {
  const t = await knex('patient_transfers').where({ id: Number(id) || 0 }).where((w) => w.where('from_business_id', ctx.businessId).orWhere('to_business_id', ctx.businessId)).first();
  if (!t) throw E.notFound('Transfer');
  return t;
}
const list = (ctx) => knex('patient_transfers as t').leftJoin('businesses as f', 'f.id', 't.from_business_id').leftJoin('businesses as d', 'd.id', 't.to_business_id')
  .where((w) => w.where('t.from_business_id', ctx.businessId).orWhere('t.to_business_id', ctx.businessId)).orderBy('t.id', 'desc').limit(30)
  .select('t.*', 'f.name as from_name', 'd.name as to_name');
const items = (id) => knex('patient_transfer_items').where({ transfer_id: id }).orderBy('id');

/** The other clinics this patient is known in (shared / moved), with their names. */
async function linksOf(businessId, patientId) {
  return knex('patient_links as l').join('businesses as b', 'b.id', 'l.other_business_id').where({ 'l.business_id': businessId, 'l.patient_id': patientId })
    .select('l.*', 'b.name as other_name', 'b.name_en as other_name_en');
}

/** Brings a moved patient back into this clinic's active list (the copy in the other clinic stays as it is). */
async function restore(ctx, patientId) {
  const p = await knex('patients').where({ id: Number(patientId), business_id: ctx.businessId }).whereNotNull('transferred_at').first('id', 'transferred_to_business_id', 'transferred_patient_id');
  if (!p) throw E.notFound('Patient');
  await knex('patients').where({ id: p.id }).update({ transferred_to_business_id: null, transferred_patient_id: null, transferred_at: null });
  if (p.transferred_to_business_id) {
    await knex('patient_links').where({ business_id: ctx.businessId, patient_id: p.id, other_business_id: p.transferred_to_business_id }).update({ kind: 'shared', updated_at: now() });
    await knex('patient_links').where({ business_id: p.transferred_to_business_id, patient_id: p.transferred_patient_id, other_business_id: ctx.businessId }).update({ kind: 'shared', updated_at: now() });
  }
  await audit.record(ctx, 'patients.transfer_restored', { entityType: 'patient', entityId: p.id, newValues: { from: p.transferred_to_business_id } });
}

/** Shared patients with each other clinic of the member (for "update all"). */
async function sharedCounts(ctx) {
  const rows = await knex('patient_links').where({ business_id: ctx.businessId, kind: 'shared' }).groupBy('other_business_id').select('other_business_id').count({ n: '*' });
  return new Map(rows.map((r) => [Number(r.other_business_id), Number(r.n)]));
}

module.exports = { MODES, MAX, targets, doctorsOf, start, sync, getTransfer, list, items, linksOf, restore, retry, sharedCounts, resumeAll, kick, settle, canManage };
