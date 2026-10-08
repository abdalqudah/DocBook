// Reading what was brought from the previous system: a patient's "Legacy Records" (the old file's details, its
// treatments, its clinical tables, its files and links) and the recovery list of every old patient of the clinic.
// Always within the clinic (business_id), never by name.
const knex = require('../../db/knex');
const lib = require('../clinic/records.lib');
const files = require('./files');

const SOURCE = 'clinica';

/** Everything imported for one patient here (an empty result when nothing was). */
async function forPatient(businessId, patientId) {
  const refs = await knex('legacy_patients').where({ business_id: businessId, patient_id: patientId }).orderBy('id');
  if (!refs.length) {
    const atts = await attachmentsOf(businessId, patientId);
    return atts.length ? { patients: [], treatments: [], clinical: [], attachments: atts, links: [], fields: [] } : null;
  }
  const ids = refs.map((r) => r.id);
  const [treatments, records, links, fields, attachments, jobs] = await Promise.all([
    knex('legacy_treatments').whereIn('legacy_patient_ref', ids).orderByRaw('treatment_on IS NULL, treatment_on DESC, position'),
    knex('legacy_clinical_records').whereIn('legacy_patient_ref', ids).orderBy(['table_key', 'position', 'id']),
    knex('legacy_patient_links').whereIn('legacy_patient_ref', ids).orderBy('id'),
    knex('legacy_field_values').where({ owner_type: 'patient' }).whereIn('owner_id', ids).orderBy(['owner_id', 'position']),
    attachmentsOf(businessId, patientId),
    knex('import_jobs').whereIn('id', refs.map((r) => r.import_job_id).filter(Boolean)).select('id', 'completed_at', 'started_at'),
  ]);
  // Clinical tables: one table per key, its columns the union of the rows' fields (in first-seen order).
  const values = records.length ? await knex('legacy_clinical_values').whereIn('record_id', records.map((r) => r.id)).orderBy(['record_id', 'position']) : [];
  const byRecord = new Map();
  values.forEach((v) => { if (!byRecord.has(v.record_id)) byRecord.set(v.record_id, []); byRecord.get(v.record_id).push(v); });
  const tables = new Map();
  records.forEach((r) => {
    if (!tables.has(r.table_key)) tables.set(r.table_key, { key: r.table_key, columns: [], rows: [] });
    const tb = tables.get(r.table_key);
    const row = {};
    (byRecord.get(r.id) || []).forEach((v) => { if (!tb.columns.includes(v.field)) tb.columns.push(v.field); row[v.field] = v.value; });
    tb.rows.push(row);
  });
  // The treatments' other fields (beyond the ten columns), shown under each row.
  const tExtra = treatments.length ? await knex('legacy_field_values').where({ owner_type: 'treatment' }).whereIn('owner_id', treatments.map((t) => t.id)).orderBy(['owner_id', 'position']) : [];
  const extraOf = new Map();
  tExtra.forEach((f) => { if (!extraOf.has(f.owner_id)) extraOf.set(f.owner_id, []); extraOf.get(f.owner_id).push(f); });
  treatments.forEach((t) => { t.extra = extraOf.get(t.id) || []; });
  const jobAt = new Map(jobs.map((j) => [j.id, j.completed_at || j.started_at]));
  refs.forEach((r) => { r.imported_on = r.imported_at || jobAt.get(r.import_job_id) || r.created_at; });
  return { patients: refs, treatments, clinical: [...tables.values()], attachments, links, fields };
}

async function attachmentsOf(businessId, patientId) {
  const rows = await knex('patient_attachments').where({ business_id: businessId, patient_id: patientId }).orderBy([{ column: 'category' }, { column: 'id' }]);
  rows.forEach((a) => { a.inline = files.INLINE.has(a.mime_type); });
  return rows;
}

/** One file of a patient (the patient must be of the clinic). */
const attachment = (businessId, patientId, id) => knex('patient_attachments').where({ id: Number(id) || 0, business_id: businessId, patient_id: Number(patientId) || 0 }).first();

/** The recovery list: every old patient of the clinic with what was brought for it. */
async function recoveryList(businessId, { q = '', status = '', page = 1 } = {}) {
  const base = knex('legacy_patients as lp').leftJoin('patients as p', function j() { this.on('p.id', 'lp.patient_id').andOn('p.business_id', 'lp.business_id'); })
    .where('lp.business_id', businessId).where('lp.legacy_source', SOURCE);
  const term = String(q || '').trim();
  if (term) {
    const like = lib.likeTerm(term);
    base.andWhere((w) => w.where('lp.legacy_patient_id', term).orWhere('lp.legacy_patient_number', term).orWhere('lp.old_name', 'like', like)
      .orWhere('lp.old_mobile', 'like', like).orWhere('lp.old_telephone', 'like', like).orWhere('p.full_name', 'like', like).orWhere('p.phone', 'like', like));
  }
  if (status === 'matched') base.whereNotNull('lp.patient_id');
  if (status === 'unmatched') base.whereNull('lp.patient_id');
  const [{ n }] = await base.clone().count({ n: '*' });
  const per = 50;
  const pg = Math.max(1, Number(page) || 1);
  const rows = await base.clone().orderBy('lp.id').limit(per).offset((pg - 1) * per).select(
    'lp.id', 'lp.patient_id', 'lp.legacy_patient_id', 'lp.legacy_patient_number', 'lp.old_name', 'lp.old_mobile', 'lp.imported_at', 'p.full_name as patient_name',
    knex.raw('(SELECT COUNT(*) FROM legacy_treatments t WHERE t.legacy_patient_ref = lp.id) as treatments'),
    knex.raw('(SELECT COUNT(*) FROM legacy_clinical_records c WHERE c.legacy_patient_ref = lp.id) as clinical'),
    knex.raw('(SELECT COUNT(*) FROM patient_attachments a WHERE a.business_id = lp.business_id AND a.legacy_source = lp.legacy_source AND a.legacy_patient_id = lp.legacy_patient_id) as files'),
  );
  return { rows, total: Number(n), page: pg, pages: Math.max(1, Math.ceil(Number(n) / per)) };
}

const legacyPatient = (businessId, ref) => knex('legacy_patients').where({ id: Number(ref) || 0, business_id: businessId }).first();

module.exports = { forPatient, attachmentsOf, attachment, recoveryList, legacyPatient };
