// Clinica treatments → the patient's own file. Each imported treatment becomes an item of the patient's treatment plan
// (dental_plan_items — shown on the patient's file and dental chart): the tooth, the procedure, the price, planned or
// done (with its date) or cancelled, and the doctor who did it. The doctors of the old system are matched here by name
// ("Dr", "د." and spelling variants ignored); a doctor not found is created (inactive — shown on the records, not
// offered for booking until the clinic turns it on). Linked both ways (legacy_treatments.plan_item_id ↔
// dental_plan_items.legacy_treatment_id, unique), so it runs once per treatment and can be run again safely — a run
// after the clinic adds its doctors fills in the doctor of items that had none.
const knex = require('../../db/knex');
const tenant = require('../../db/tenant');
const { foldText } = require('../clinic/records.lib');
const { defaultWorkingHours } = require('../clinic/scheduling');
const map = require('./clinica-map');

const SOURCE = 'clinica';
const PREFIX = /^(?:(?:dr|doctor|prof)\.?\s+|(?:ال)?دكتور[ةه]?\s+|د\.?\s*(?=\S))/i;
const docKey = (name) => foldText(String(name || '').trim().replace(PREFIX, '').replace(PREFIX, '')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const DONE = /(done|complete|finish|closed|منجز|مكتمل|منته|تم)/i;
const CANCELLED = /(cancel|void|ملغ|الغاء|إلغاء)/i;
function statusOf(t) {
  const s = String(t.status || '');
  if (CANCELLED.test(s)) return 'cancelled';
  if (DONE.test(s) || map.isoDay(t.complete_date)) return 'done';
  return 'planned';
}
/** FDI tooth number (11–48 permanent, 51–85 primary) or null. */
function toothOf(v) {
  const s = String(v || '').trim();
  if (!/^\d{2}$/.test(s)) return null;
  const n = Number(s); const q = Math.floor(n / 10); const i = n % 10;
  return ((q >= 1 && q <= 4 && i >= 1 && i <= 8) || (q >= 5 && q <= 8 && i >= 1 && i <= 5)) ? n : null;
}

/** The clinic's doctors by name (and English name). */
async function doctorIndex(db, businessId) {
  const rows = await db('doctors').where({ business_id: businessId }).select('id', 'full_name', 'full_name_en');
  const ix = new Map();
  rows.forEach((d) => [d.full_name, d.full_name_en].map(docKey).filter(Boolean).forEach((k) => { if (!ix.has(k)) ix.set(k, d.id); }));
  return ix;
}
async function doctorFor(db, businessId, ix, name, stats) {
  const key = docKey(name);
  if (!key) return null;
  if (ix.has(key)) return ix.get(key);
  const [id] = await db('doctors').insert({
    business_id: businessId, full_name: String(name).trim().slice(0, 190), is_active: false, working_hours: JSON.stringify(defaultWorkingHours()),
    slot_duration_minutes: 30, legacy_source: SOURCE,
  });
  ix.set(key, id);
  if (stats) stats.doctors_created = (stats.doctors_created || 0) + 1;
  return id;
}

const line = (label, v) => (v === null || v === undefined || String(v).trim() === '' ? null : `${label}: ${String(v).trim()}`);

/** Converts the treatments of one patient (in `db`, a transaction or knex) → number of plan items made. */
async function promotePatient(db, businessId, patientId, { ix = null, stats = null } = {}) {
  const rows = await db('legacy_treatments').where({ business_id: businessId, patient_id: patientId }).orderBy(['treatment_on', 'position', 'id']);
  if (!rows.length) return 0;
  const index = ix || await doctorIndex(db, businessId);
  let made = 0;
  for (const t of rows) { // eslint-disable-line no-restricted-syntax
    const doctorId = t.doctor ? await doctorFor(db, businessId, index, t.doctor, stats) : null; // eslint-disable-line no-await-in-loop
    if (t.plan_item_id) {
      // Already converted: only a doctor found since (or the patient after a re-link) is filled in.
      const item = await db('dental_plan_items').where({ id: t.plan_item_id, business_id: businessId }).first('id', 'doctor_id', 'patient_id'); // eslint-disable-line no-await-in-loop
      if (item) {
        const patch = {};
        if (!item.doctor_id && doctorId) patch.doctor_id = doctorId;
        if (item.patient_id !== patientId) patch.patient_id = patientId;
        if (Object.keys(patch).length) await db('dental_plan_items').where({ id: item.id }).update(patch); // eslint-disable-line no-await-in-loop
        if (!t.doctor_id && doctorId) await db('legacy_treatments').where({ id: t.id }).update({ doctor_id: doctorId }); // eslint-disable-line no-await-in-loop
        continue; // eslint-disable-line no-continue
      }
    }
    const status = statusOf(t);
    const tooth = toothOf(t.tooth);
    const day = map.isoDay(t.treatment_date) || t.treatment_on || null;
    const doneOn = status === 'done' ? (map.isoDay(t.complete_date) || day) : null;
    const notes = [
      t.tooth && !tooth ? line('Tooth / السن', t.tooth) : null,
      line('Type / النوع', t.type), status !== 'done' && day ? line('Date / التاريخ', day) : null,
      t.status && !['done', 'planned'].includes(String(t.status).toLowerCase()) ? line('Status / الحالة', t.status) : null,
      line('Note / ملاحظة', t.note), line('Referred by / محوّل من', t.referred_by),
      t.price === null && t.price_raw ? line('Price / السعر', t.price_raw) : null,
    ].filter(Boolean).join('\n') || null;
    const at = day ? new Date(`${day}T12:00:00Z`) : new Date();
    const [pid] = await db('dental_plan_items').insert({ // eslint-disable-line no-await-in-loop
      business_id: businessId, patient_id: patientId, tooth, procedure_name: String(t.description || t.type || 'Treatment').trim().slice(0, 190) || 'Treatment',
      price: t.price === null || t.price === undefined ? null : t.price, status, done_on: doneOn, doctor_id: doctorId, notes, legacy_treatment_id: t.id,
      created_at: at, updated_at: at,
    }).onConflict(['legacy_treatment_id']).ignore();
    const itemId = pid || (await db('dental_plan_items').where({ legacy_treatment_id: t.id }).first('id')).id; // eslint-disable-line no-await-in-loop
    await db('legacy_treatments').where({ id: t.id }).update({ plan_item_id: itemId, doctor_id: doctorId }); // eslint-disable-line no-await-in-loop
    made += 1;
  }
  if (stats) stats.plan_items = (stats.plan_items || 0) + made;
  return made;
}

/** How far the clinic's imported treatments are in the patients' files. */
async function progress(businessId) {
  const [[all], [done], [waiting], [docs]] = await Promise.all([
    knex('legacy_treatments').where({ business_id: businessId }).count({ n: '*' }),
    knex('legacy_treatments').where({ business_id: businessId }).whereNotNull('plan_item_id').count({ n: '*' }),
    knex('legacy_treatments').where({ business_id: businessId }).whereNull('plan_item_id').whereNull('patient_id').count({ n: '*' }),
    knex('doctors').where({ business_id: businessId, legacy_source: SOURCE }).count({ n: '*' }),
  ]);
  return { total: Number(all.n), done: Number(done.n), unlinked: Number(waiting.n), doctorsCreated: Number(docs.n), running: running.has(businessId) };
}

const running = new Map();
/** Converts every imported treatment of the clinic not yet in a patient's file (background; one run per clinic). */
function promoteAll(businessId) {
  if (running.has(businessId)) return running.get(businessId);
  const p = tenant.runFor(businessId, async () => {
    const ix = await doctorIndex(knex, businessId);
    const stats = {};
    for (;;) {
      const pids = await knex('legacy_treatments').where({ business_id: businessId }).whereNull('plan_item_id').whereNotNull('patient_id').distinct('patient_id').limit(200).pluck('patient_id'); // eslint-disable-line no-await-in-loop
      if (!pids.length) break;
      for (const pid of pids) await knex.transaction((trx) => promotePatient(trx, businessId, pid, { ix, stats })); // eslint-disable-line no-restricted-syntax, no-await-in-loop
    }
    // Treatments converted earlier whose doctor was not known then.
    const late = await knex('legacy_treatments').where({ business_id: businessId }).whereNotNull('plan_item_id').whereNull('doctor_id').whereNotNull('doctor').whereNotNull('patient_id').distinct('patient_id').pluck('patient_id');
    for (const pid of late) await promotePatient(knex, businessId, pid, { ix, stats }); // eslint-disable-line no-restricted-syntax, no-await-in-loop
    return stats;
  }).finally(() => running.delete(businessId));
  running.set(businessId, p);
  return p;
}

module.exports = { promotePatient, promoteAll, progress, doctorIndex, docKey, statusOf, toothOf };
