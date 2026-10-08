// "Remove everything that came from Clinica": undoes the legacy import of a clinic so it can be done again cleanly.
// Removed: the calendar visits it made (external_source = 'clinica'), the treatment-plan items it made
// (legacy_treatment_id), the files it brought (patient_attachments of source clinica — and their stored copies when
// nothing else uses them), every legacy_* row, the doctor choices, the import jobs, and
//   • the patients the import CREATED — unless the clinic has since added its own records to one (a visit, an invoice,
//     a note, a prescription, a file, a plan item…): those are kept (their link to Clinica is cleared) and counted;
//   • the doctors it created (legacy_source = 'clinica') that nothing points at any more.
// Patients that existed before and were only linked keep everything of their own (their Clinica link is cleared).
// Owner-only, typed confirmation, audited; it runs in steps and can be pressed again if it was interrupted.
const fs = require('fs');
const knex = require('../../db/knex');
const tenant = require('../../db/tenant');
const audit = require('../../core/audit');
const files = require('./files');
const svc = require('./import.service');

const SOURCE = 'clinica';
const CHUNK = 500;
const running = new Map();

async function inChunks(ids, fn) { for (let i = 0; i < ids.length; i += CHUNK) await fn(ids.slice(i, i + CHUNK)); } // eslint-disable-line no-await-in-loop

/** What would be removed (for the confirmation). */
async function preview(businessId) {
  const c = async (q) => Number((await q.count({ n: '*' }))[0].n);
  return {
    patients: await c(knex('patients').where({ business_id: businessId, legacy_source: SOURCE })),
    visits: await c(knex('appointments').where({ business_id: businessId, external_source: SOURCE })),
    plan: await c(knex('dental_plan_items').where({ business_id: businessId }).whereNotNull('legacy_treatment_id')),
    files: await c(knex('patient_attachments').where({ business_id: businessId, legacy_source: SOURCE })),
    doctors: await c(knex('doctors').where({ business_id: businessId, legacy_source: SOURCE })),
    running: running.has(businessId),
  };
}

async function run(ctx) {
  const b = ctx.businessId;
  const report = { patients_removed: 0, patients_kept: 0, visits: 0, plan_items: 0, files: 0, doctors: 0 };
  // Patients the import created (the import recorded it on each patient item as match 'new').
  const created = new Set((await knex('import_items').where({ business_id: b, kind: 'patient', match: 'new' }).whereNotNull('target_id').pluck('target_id')).map(Number));
  // 1. What the conversion made: calendar visits and treatment-plan items.
  report.visits = await knex('appointments').where({ business_id: b, external_source: SOURCE }).del();
  report.plan_items = await knex('dental_plan_items').where({ business_id: b }).whereNotNull('legacy_treatment_id').del();
  // 2. The files (stored copies removed when no other row of the clinic uses them).
  const atts = await knex('patient_attachments').where({ business_id: b, legacy_source: SOURCE }).select('id', 'storage_path');
  await inChunks(atts.map((a) => a.id), (ids) => knex('patient_attachments').whereIn('id', ids).del());
  for (const p of [...new Set(atts.map((a) => a.storage_path))]) { // eslint-disable-line no-restricted-syntax
    if (!(await knex('patient_attachments').where({ business_id: b, storage_path: p }).first('id'))) files.drop(p); // eslint-disable-line no-await-in-loop
  }
  report.files = atts.length;
  // 3. The created patients — kept when the clinic has added its own records to them since.
  const ids = [...created];
  const own = new Set();
  await inChunks(ids, async (chunk) => {
    const hit = (rows) => rows.forEach((x) => own.add(Number(x)));
    hit(await knex('appointments').where({ business_id: b }).whereIn('patient_id', chunk).where((w) => w.whereNull('external_source').orWhereNot('external_source', SOURCE)).distinct('patient_id').pluck('patient_id'));
    for (const t of ['invoices', 'consultations', 'prescriptions', 'patient_files', 'certificates', 'specialty_records', 'medical_orders', 'referrals', 'surgeries']) { // eslint-disable-line no-restricted-syntax
      hit(await knex(t).where({ business_id: b }).whereIn('patient_id', chunk).distinct('patient_id').pluck('patient_id')); // eslint-disable-line no-await-in-loop
    }
    hit(await knex('dental_plan_items').where({ business_id: b }).whereIn('patient_id', chunk).whereNull('legacy_treatment_id').distinct('patient_id').pluck('patient_id'));
  });
  const removable = ids.filter((id) => !own.has(id));
  await inChunks(removable, async (chunk) => { report.patients_removed += await knex('patients').where({ business_id: b, legacy_source: SOURCE }).whereIn('id', chunk).del(); });
  report.patients_kept = ids.length - removable.length;
  // 4. Every other patient keeps its own data; its Clinica link is cleared.
  await knex('patients').where({ business_id: b, legacy_source: SOURCE }).update({ legacy_source: null, legacy_patient_id: null, legacy_patient_number: null, legacy_import_job_id: null, legacy_imported_at: null });
  // 5. The legacy rows, doctor choices and jobs.
  const refs = knex('legacy_patients').where({ business_id: b }).select('id');
  await knex('legacy_clinical_values').whereIn('record_id', knex('legacy_clinical_records').where({ business_id: b }).select('id')).del();
  await knex('legacy_clinical_records').where({ business_id: b }).del();
  await knex('legacy_field_values').where({ business_id: b }).del();
  await knex('legacy_treatments').where({ business_id: b }).del();
  await knex('legacy_patient_links').whereIn('legacy_patient_ref', refs).del();
  await knex('legacy_patients').where({ business_id: b }).del();
  await knex('legacy_doctor_map').where({ business_id: b }).del();
  await knex('legacy_branch_map').where({ business_id: b }).del();
  const jobs = await knex('import_jobs').where({ business_id: b }).whereIn('type', [svc.TYPE, 'legacy_promote', 'legacy_remote']).select('id');
  for (const j of jobs) fs.rmSync(svc.jobDir(b, j.id), { recursive: true, force: true }); // eslint-disable-line no-restricted-syntax
  await knex('import_jobs').where({ business_id: b }).whereIn('id', jobs.map((j) => j.id)).del(); // items, batches, errors follow (cascade)
  // 6. Doctors the import created that nothing uses now.
  const docs = await knex('doctors').where({ business_id: b, legacy_source: SOURCE }).pluck('id');
  for (const id of docs) { // eslint-disable-line no-restricted-syntax
    try { report.doctors += await knex('doctors').where({ id, business_id: b }).whereNotExists(knex('appointments').where('doctor_id', id).select(1)).whereNotExists(knex('dental_plan_items').where('doctor_id', id).select(1)).del(); } // eslint-disable-line no-await-in-loop
    catch { /* still referenced elsewhere: kept */ }
  }
  await audit.record(ctx, 'legacy.import_removed', { entityType: 'business', entityId: b, oldValues: report });
  return report;
}

/** Starts the removal in the background (one per clinic) → the running promise. */
function start(ctx) {
  if (running.has(ctx.businessId)) return running.get(ctx.businessId);
  const p = tenant.runFor(ctx.businessId, () => run(ctx)).finally(() => running.delete(ctx.businessId));
  running.set(ctx.businessId, p);
  p.catch((e) => console.error('[legacy-purge]', e.message)); // eslint-disable-line no-console
  return p;
}

module.exports = { preview, start, run };
