// Clinica data → the patient's own file:
//   • each treatment becomes an item of the patient's treatment plan (dental_plan_items: tooth, treatment, price, done
//     with its date / planned / cancelled, the doctor), shown on the patient's file and the dental chart;
//   • the old calendar fills the clinic's calendar: the Clinica appointments when the file has them, and one visit per
//     day of treatments (the doctor of that day, the treatments in its notes) — completed when past, confirmed when to
//     come. These visits are marked external_source = 'clinica' and payment 'imported': they are history, never "unpaid"
//     at the cash desk, and no message (review request) is sent for them;
//   • the doctor of each Clinica name is the one the clinic chose on the "Doctors" page (legacy_doctor_map: an existing
//     doctor, a new doctor with that name, "from the patient's visits", or none), else a doctor here with the same name
//     ("Dr", "د." ignored; an English name finds the same doctor written in Arabic), else none. A chair written where the
//     doctor goes ("Clinic One"…) and a treatment with no doctor take, unless chosen otherwise, the patient's doctor of
//     that day, else the patient's usual doctor, else the doctor seen most with that name (clinica-clean.inferDoctors);
//   • descriptions are cleaned of Clinica's page text ("more…", "View Notes"); their details ("Chief Complaint: …") go to
//     the notes. The patient's Clinica groups become patient groups; a group can be tied to a branch (legacy_branch_map),
//     else a visit is on its doctor's branch.
// Everything is keyed (plan item ↔ treatment; appointment external_uid), so it runs once and can run again: a run after
// the doctors are chosen fills / corrects the doctors of what it made (not of what a person changed since).
// It runs as a saved job (import_jobs type legacy_promote, heartbeat), so a stopped server carries on where it was.
const crypto = require('crypto');
const knex = require('../../db/knex');
const tenant = require('../../db/tenant');
const { foldText } = require('../clinic/records.lib');
const { defaultWorkingHours, clinicNow } = require('../clinic/scheduling');
const map = require('./clinica-map');
const clean = require('./clinica-clean');

const SOURCE = 'clinica';
const TYPE = 'legacy_promote';
const STALE_MS = 2 * 60_000;
const RUNNER = `${require('os').hostname().slice(0, 20)}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`; // eslint-disable-line global-require
const PREFIX = /^(?:(?:dr|doctor|prof)\.?\s+|(?:ال)?دكتور[ةه]?\s+|د\.?\s*(?=\S))/i;
const docKey = (name) => foldText(String(name || '').trim().replace(PREFIX, '').replace(PREFIX, '')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 190);
const now = () => new Date();

const DONE = /(done|complete|finish|closed|منجز|مكتمل|منته|تم)/i;
const CANCELLED = /(cancel|void|ملغ|الغاء|إلغاء)/i;
const NO_SHOW = /(no.?show|absent|missed|لم يحضر|غياب|غائب)/i;
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

// ================================================================= doctors
/** Doctors here by name: the same name ("Dr" / "د." ignored), else the one doctor whose name (Arabic or English) sounds the same. */
function nameIndex(rows) {
  const byName = new Map();
  rows.forEach((d) => [d.full_name, d.full_name_en].map(docKey).filter(Boolean).forEach((k) => { if (!byName.has(k)) byName.set(k, d.id); }));
  const people = rows.map((d) => ({ id: d.id, names: [d.full_name, d.full_name_en].filter(Boolean) }));
  return (name) => {
    const key = docKey(name);
    if (!key) return null;
    if (byName.has(key)) return byName.get(key);
    const id = clean.matchDoctor(name, people);
    byName.set(key, id);
    return id;
  };
}
/** Whether a name stands for no doctor (a chair "Clinic One"… or nothing): its doctor is found from the patient's visits. */
const notADoctor = (name) => !docKey(name) || clean.chairOf(name) !== null;

/**
 * name → doctor id here: the clinic's choice, else the same name, else none (a 'create' choice makes the doctor once).
 * resolve.infers(name): the treatment's doctor is found from the patient's visits ('infer' choice; the default for a
 * chair and for no name). resolve.usualFor(name): the doctor seen most with that name over the clinic's data.
 */
async function resolver(db, businessId) {
  const [rows, maps, groups] = await Promise.all([
    db('doctors').where({ business_id: businessId }).select('id', 'full_name', 'full_name_en', 'branch_id'),
    db('legacy_doctor_map').where({ business_id: businessId, legacy_source: SOURCE }),
    db('legacy_branch_map').where({ business_id: businessId, legacy_source: SOURCE }).select('group_key', 'branch_id').catch(() => []),
  ]);
  const byName = nameIndex(rows);
  const branchOf = new Map(rows.map((d) => [d.id, d.branch_id || null]));
  const groupBranch = new Map(groups.filter((g) => g.branch_id).map((g) => [g.group_key, g.branch_id]));
  const chosen = new Map(maps.map((m) => [m.name_key, m]));
  const usual = new Map();
  const resolve = async (name) => {
    const key = docKey(name);
    const m = chosen.get(key);
    if (resolve.infers(name)) return null;
    if (m) {
      if (m.action === 'none') return null;
      if (m.action === 'doctor' && m.doctor_id) return m.doctor_id;
      if (m.action === 'create' && key) {
        const [id] = await db('doctors').insert({ business_id: businessId, full_name: String(m.name || name).trim().slice(0, 190), is_active: false, working_hours: JSON.stringify(defaultWorkingHours()), slot_duration_minutes: 30, legacy_source: SOURCE });
        await db('legacy_doctor_map').where({ id: m.id }).update({ action: 'doctor', doctor_id: id, updated_at: now() });
        Object.assign(m, { action: 'doctor', doctor_id: id }); branchOf.set(id, null);
        return id;
      }
    }
    return byName(name);
  };
  resolve.infers = (name) => { const m = chosen.get(docKey(name)); return m ? m.action === 'infer' : notADoctor(name); };
  resolve.usualFor = async (name) => {
    const key = docKey(name);
    if (usual.has(key)) return usual.get(key);
    // the doctors of the other treatments of the patients who have this name, the most frequent first
    const raw = String(name || '').trim();
    const pats = db('legacy_treatments').where({ business_id: businessId }).whereNotNull('patient_id')
      .where((w) => (raw ? w.where('doctor', raw) : w.whereNull('doctor').orWhere('doctor', ''))).distinct('patient_id');
    const counts = await db('legacy_treatments').where({ business_id: businessId }).whereIn('patient_id', pats).whereNotNull('doctor').whereNot('doctor', '')
      .groupBy('doctor').select('doctor').count({ n: '*' });
    const tally = new Map();
    for (const c of counts) { // eslint-disable-line no-restricted-syntax
      if (resolve.infers(c.doctor)) continue; // eslint-disable-line no-continue
      const id = await resolve(c.doctor); // eslint-disable-line no-await-in-loop
      if (id) tally.set(id, (tally.get(id) || 0) + Number(c.n));
    }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    usual.set(key, best ? best[0] : null);
    return usual.get(key);
  };
  resolve.branchFor = (groups, doctorId) => {
    for (const g of groups) { const k = docKey(g); if (groupBranch.has(k)) return groupBranch.get(k); } // eslint-disable-line no-restricted-syntax
    return doctorId ? branchOf.get(doctorId) || null : null;
  };
  return resolve;
}
/** The Clinica group text of a patient ("Implant,Abdali Hospital") → its groups. */
const groupsOf = (text) => String(text || '').split(/[,|،;]/).map((g) => g.replace(/\s+/g, ' ').trim()).filter(Boolean);

/** The doctor names of the clinic's Clinica data, with how many treatments / what they map to now. */
async function doctorNames(businessId) {
  const rows = await knex('legacy_treatments').where({ business_id: businessId }).groupBy('doctor').select('doctor').count({ n: '*' });
  const [docs, maps, branches, groupRows, groupMap] = await Promise.all([
    knex('doctors').where({ business_id: businessId }).orderBy('full_name').select('id', 'full_name', 'full_name_en', 'is_active', 'legacy_source'),
    knex('legacy_doctor_map').where({ business_id: businessId, legacy_source: SOURCE }),
    knex('clinic_branches').where({ business_id: businessId }).orderBy(['sort_order', 'id']).select('id', 'name', 'name_en', 'is_active').catch(() => []),
    knex('legacy_patients').where({ business_id: businessId, legacy_source: SOURCE }).whereNotNull('old_group').whereNot('old_group', '').groupBy('old_group').select('old_group').count({ n: '*' }),
    knex('legacy_branch_map').where({ business_id: businessId, legacy_source: SOURCE }).catch(() => []),
  ]);
  const byName = nameIndex(docs);
  const chosen = new Map(maps.map((m) => [m.name_key, m]));
  const agg = new Map();
  rows.forEach((r) => {
    const key = docKey(r.doctor);
    // spellings of one name ("Raghad  Kafina", "Raghad Kafina") are one row
    if (!agg.has(key)) agg.set(key, { key, name: key ? clean.doctorName(r.doctor) : '', count: 0, chair: key ? clean.chairOf(r.doctor) !== null : false });
    agg.get(key).count += Number(r.n);
  });
  const list = [...agg.values()].sort((a, b) => (!a.key) - (!b.key) || a.chair - b.chair || b.count - a.count).map((x) => {
    const m = chosen.get(x.key);
    const auto = x.key && !x.chair ? byName(x.name) : null;
    const action = m ? m.action : (notADoctor(x.name) ? 'infer' : (auto ? 'doctor' : 'none'));
    return { ...x, action, doctorId: m ? m.doctor_id : auto, chosen: Boolean(m), auto };
  });
  // the patient groups of the Clinica data and the branch each is on
  const gm = new Map(groupMap.map((g) => [g.group_key, g.branch_id]));
  const gc = new Map();
  groupRows.forEach((r) => groupsOf(r.old_group).forEach((g) => {
    const k = docKey(g);
    if (!gc.has(k)) gc.set(k, { key: k, name: g, count: 0, branchId: gm.get(k) || null });
    gc.get(k).count += Number(r.n);
  }));
  return { list, doctors: docs, branches, groups: [...gc.values()].sort((a, b) => b.count - a.count) };
}

/** Saves the clinic's choices ({ key, action, doctor_id }) and re-applies them (a job). */
async function saveDoctorMap(ctx, entries, groupEntries = []) {
  const docs = new Set((await knex('doctors').where({ business_id: ctx.businessId }).pluck('id')).map(Number));
  const { list, branches, groups } = await doctorNames(ctx.businessId);
  const names = new Map(list.map((x) => [x.key, x.name]));
  for (const e of entries) { // eslint-disable-line no-restricted-syntax
    const key = String(e.key || '');
    if (!names.has(key)) continue; // eslint-disable-line no-continue
    let action = ['doctor', 'create', 'none', 'infer'].includes(e.action) ? e.action : 'none';
    const doctorId = action === 'doctor' && docs.has(Number(e.doctor_id)) ? Number(e.doctor_id) : null;
    if (action === 'doctor' && !doctorId) action = 'none';
    if (action === 'create' && !key) action = 'none';
    await knex('legacy_doctor_map').insert({ business_id: ctx.businessId, legacy_source: SOURCE, name_key: key, name: names.get(key) || null, action, doctor_id: doctorId }) // eslint-disable-line no-await-in-loop
      .onConflict(['business_id', 'legacy_source', 'name_key']).merge({ action, doctor_id: doctorId, name: names.get(key) || null, updated_at: now() });
  }
  const branchIds = new Set(branches.map((b) => Number(b.id)));
  const groupNames = new Map(groups.map((g) => [g.key, g.name]));
  for (const g of groupEntries) { // eslint-disable-line no-restricted-syntax
    const key = String(g.key || '');
    if (!key || !groupNames.has(key)) continue; // eslint-disable-line no-continue
    const branchId = branchIds.has(Number(g.branch_id)) ? Number(g.branch_id) : null;
    await knex('legacy_branch_map').insert({ business_id: ctx.businessId, legacy_source: SOURCE, group_key: key, group_name: groupNames.get(key), branch_id: branchId }) // eslint-disable-line no-await-in-loop
      .onConflict(['business_id', 'legacy_source', 'group_key']).merge({ branch_id: branchId, group_name: groupNames.get(key), updated_at: now() });
  }
  await require('../../core/audit').record(ctx, 'legacy.doctors_mapped', { entityType: 'business', entityId: ctx.businessId, newValues: { entries: entries.length, groups: groupEntries.length } }); // eslint-disable-line global-require
  return start(ctx);
}

// ================================================================= the old calendar
const LISTS = ['appointments', 'appointment', 'visits', 'bookings', 'calendar', 'reservations', 'sessions'];
const A = {
  date: ['date', 'appointment_date', 'start', 'start_date', 'datetime', 'from', 'day', 'visit_date'],
  time: ['time', 'start_time', 'from_time', 'hour', 'appointment_time'],
  doctor: ['doctor', 'doctor_name', 'dr', 'provider', 'dentist'],
  status: ['status', 'state'],
  note: ['note', 'notes', 'comment', 'comments', 'reason', 'description', 'title', 'subject'],
  duration: ['duration', 'duration_minutes', 'minutes', 'length'],
  id: ['id', 'appointment_id', 'booking_id', 'uid'],
};
const pick = (o, names) => { const k = map.pickKey(o, names); return k === null ? null : o[k]; };
const timeOf = (...vs) => {
  for (const v of vs) { // eslint-disable-line no-restricted-syntax
    const m = /(\d{1,2}):(\d{2})/.exec(String(v || ''));
    if (m && Number(m[1]) < 24 && Number(m[2]) < 60) {
      let h = Number(m[1]);
      if (/pm|م/i.test(String(v)) && h < 12) h += 12;
      return `${String(h).padStart(2, '0')}:${m[2]}`;
    }
  }
  return null;
};

/** Clinica appointments kept with the patient's record (fields like appointments[3].date) → [{ key, date, time, … }]. */
async function oldAppointments(db, refs) {
  if (!refs.length) return [];
  const rows = await db('legacy_field_values').where({ owner_type: 'patient' }).whereIn('owner_id', refs)
    .where((w) => LISTS.forEach((l) => w.orWhere('field', 'like', `${l}[%`))).select('owner_id', 'field', 'value');
  const recs = new Map();
  rows.forEach((r) => {
    const m = /^([A-Za-z_]+)\[(\d+)\]\.?(.*)$/.exec(r.field);
    if (!m || !LISTS.includes(m[1].toLowerCase())) return;
    const k = `${r.owner_id}:${m[1]}:${m[2]}`;
    if (!recs.has(k)) recs.set(k, { k, owner: r.owner_id, o: {} });
    recs.get(k).o[m[3] || 'value'] = r.value;
  });
  return [...recs.values()].map(({ k, owner, o }) => {
    const dateRaw = pick(o, A.date) || o.value;
    const date = map.isoDay(dateRaw);
    if (!date) return null;
    const id = pick(o, A.id);
    return {
      owner, key: id ? `a:${String(id).slice(0, 60)}` : `a:${crypto.createHash('sha1').update(k + JSON.stringify(o)).digest('hex').slice(0, 24)}`,
      date, time: timeOf(pick(o, A.time), dateRaw), doctor: pick(o, A.doctor), status: String(pick(o, A.status) || ''),
      note: pick(o, A.note), duration: Number(pick(o, A.duration)) || null,
    };
  }).filter(Boolean);
}

async function upsertVisit(db, businessId, patient, v) {
  const at = new Date(`${v.date}T12:00:00Z`);
  const uid = `clinica:${patient.legacyId}:${v.key}`.slice(0, 190);
  const row = {
    business_id: businessId, doctor_id: v.doctorId || null, patient_id: patient.id, patient_name: String(patient.name || '').slice(0, 190) || '—', patient_phone: patient.phone || null,
    appointment_date: v.date, appointment_time: v.time || '09:00', duration_minutes: v.duration || null, status: v.status, appointment_type: 'in_person', source: 'import', branch_id: v.branchId || null,
    // history: 'imported' (never "unpaid" at the cash desk); a booking still to come is an ordinary booking
    payment_status: v.status === 'confirmed' ? 'unpaid' : 'imported', amount_due: 0, notes: v.notes ? String(v.notes).slice(0, 3000) : null, external_source: SOURCE, external_uid: uid, created_at: at, updated_at: at,
  };
  await db('appointments').insert(row).onConflict(['business_id', 'external_uid']).ignore();
  const a = await db('appointments').where({ business_id: businessId, external_uid: uid }).first('id', 'doctor_id', 'patient_id', 'branch_id');
  // A doctor chosen since (or the patient re-linked) is set on the visit this import made; a branch only where none is.
  const patch = {};
  if (v.doctorId && a.doctor_id !== v.doctorId && v.mayChangeDoctor(a.doctor_id)) patch.doctor_id = v.doctorId;
  if (v.branchId && !a.branch_id) patch.branch_id = v.branchId;
  if (a.patient_id !== patient.id) patch.patient_id = patient.id;
  if (Object.keys(patch).length) await db('appointments').where({ id: a.id }).update(patch);
  return a.id;
}

const line = (label, v) => (v === null || v === undefined || String(v).trim() === '' ? null : `${label}: ${String(v).trim()}`);

// ================================================================= one patient
/** Treatments → treatment plan, and the old calendar → appointments, for one patient (db: a transaction or knex). */
async function promotePatient(db, businessId, patientId, { resolve = null, stats = null, today = null } = {}) {
  const [patient, refs] = await Promise.all([
    db('patients').where({ id: patientId, business_id: businessId }).first('id', 'full_name', 'phone'),
    db('legacy_patients').where({ business_id: businessId, patient_id: patientId, legacy_source: SOURCE }).select('id', 'legacy_patient_id', 'old_group'),
  ]);
  if (!patient || !refs.length) return 0;
  const doctorOf = resolve || await resolver(db, businessId);
  const day0 = today || clinicNow('Asia/Amman').date;
  const rows = await db('legacy_treatments').where({ business_id: businessId, patient_id: patientId }).orderBy(['treatment_on', 'position', 'id']);
  const dayOf = (t) => t.treatment_on || map.isoDay(t.treatment_date) || null;
  // 1. The doctor of each treatment: the clinic's choice / the same name; a chair or no name → from the patient's visits.
  for (const t of rows) t.resolved = doctorOf.infers(t.doctor) ? null : await doctorOf(t.doctor); // eslint-disable-line no-restricted-syntax, no-await-in-loop
  const inferred = clean.inferDoctors(rows, { needs: (t) => doctorOf.infers(t.doctor), doctorOf: (t) => t.resolved, dayOf });
  for (const t of rows) { // eslint-disable-line no-restricted-syntax
    if (!doctorOf.infers(t.doctor)) continue; // eslint-disable-line no-continue
    t.resolved = inferred.get(t) || (doctorOf.usualFor ? await doctorOf.usualFor(t.doctor) : null) || null; // eslint-disable-line no-await-in-loop
    t.inferred = true;
  }
  // 2. Each treatment → an item of the treatment plan.
  let made = 0;
  for (const t of rows) { // eslint-disable-line no-restricted-syntax
    const doctorId = t.resolved;
    if (t.plan_item_id) {
      const item = await db('dental_plan_items').where({ id: t.plan_item_id, business_id: businessId }).first('id', 'doctor_id', 'patient_id'); // eslint-disable-line no-await-in-loop
      if (item) {
        const patch = {};
        // the doctor this import set (not one a person chose since) follows the clinic's choice
        if (item.doctor_id !== doctorId && (item.doctor_id === null || item.doctor_id === t.doctor_id)) patch.doctor_id = doctorId;
        if (item.patient_id !== patientId) patch.patient_id = patientId;
        if (Object.keys(patch).length) await db('dental_plan_items').where({ id: item.id }).update(patch); // eslint-disable-line no-await-in-loop
        if (t.doctor_id !== doctorId) await db('legacy_treatments').where({ id: t.id }).update({ doctor_id: doctorId }); // eslint-disable-line no-await-in-loop
        continue; // eslint-disable-line no-continue
      }
    }
    const status = statusOf(t);
    const tooth = toothOf(t.tooth);
    const day = dayOf(t);
    const doneOn = status === 'done' ? (map.isoDay(t.complete_date) || day) : null;
    const desc = clean.cleanTreatment(t.description);
    const notes = [
      ...desc.lines,
      t.tooth && !tooth ? line('Tooth / السن', t.tooth) : null,
      line('Type / النوع', t.type), status !== 'done' && day ? line('Date / التاريخ', day) : null,
      t.status && !['done', 'planned', 'complete'].includes(String(t.status).toLowerCase()) ? line('Status / الحالة', t.status) : null,
      line('Note / ملاحظة', t.note), line('Referred by / محوّل من', t.referred_by),
      t.price === null && t.price_raw ? line('Price / السعر', t.price_raw) : null,
      (!doctorId || t.inferred) && t.doctor ? line('Clinica', clean.doctorName(t.doctor)) : null,
    ].filter(Boolean).join('\n') || null;
    const at = day ? new Date(`${day}T12:00:00Z`) : now();
    await db('dental_plan_items').insert({ // eslint-disable-line no-await-in-loop
      business_id: businessId, patient_id: patientId, tooth, procedure_name: String(desc.name || t.type || 'Treatment').trim().slice(0, 190) || 'Treatment',
      price: t.price === null || t.price === undefined ? null : t.price, status, done_on: doneOn, doctor_id: doctorId, notes, legacy_treatment_id: t.id,
      created_at: at, updated_at: at,
    }).onConflict(['legacy_treatment_id']).ignore();
    const itemId = (await db('dental_plan_items').where({ legacy_treatment_id: t.id }).first('id')).id; // eslint-disable-line no-await-in-loop
    await db('legacy_treatments').where({ id: t.id }).update({ plan_item_id: itemId, doctor_id: doctorId }); // eslint-disable-line no-await-in-loop
    t.plan_item_id = itemId;
    made += 1;
  }

  // 3. The patient's Clinica groups → patient groups.
  const groups = [...new Set(refs.flatMap((r) => groupsOf(r.old_group)))];
  for (const g of groups) { // eslint-disable-line no-restricted-syntax
    const name = g.slice(0, 60);
    await db('patient_groups').insert({ business_id: businessId, name }).onConflict(['business_id', 'name']).ignore(); // eslint-disable-line no-await-in-loop
    const grp = await db('patient_groups').where({ business_id: businessId, name }).first('id'); // eslint-disable-line no-await-in-loop
    if (grp) await db('patient_group_members').insert({ business_id: businessId, patient_id: patientId, group_id: grp.id }).onConflict(['patient_id', 'group_id']).ignore(); // eslint-disable-line no-await-in-loop
  }
  const branchFor = (doctorId) => (doctorOf.branchFor ? doctorOf.branchFor(groups, doctorId) : null);

  // 4. The old calendar: Clinica's own appointments, then one visit per day and doctor of treatments not already on it.
  const legacyId = refs[0].legacy_patient_id;
  const who = { id: patientId, name: patient.full_name, phone: patient.phone, legacyId };
  const ownSet = (prev) => prev === null; // only fill a doctor that is not set
  const booked = new Set();
  let visits = 0;
  for (const a of await oldAppointments(db, refs.map((r) => r.id))) { // eslint-disable-line no-restricted-syntax, no-await-in-loop
    const doctorId = doctorOf.infers(a.doctor) ? null : await doctorOf(a.doctor); // eslint-disable-line no-await-in-loop
    const st = CANCELLED.test(a.status) ? 'cancelled' : NO_SHOW.test(a.status) ? 'no_show' : a.date < day0 ? 'completed' : 'confirmed';
    await upsertVisit(db, businessId, who, { key: a.key, date: a.date, time: a.time, duration: a.duration, doctorId, branchId: branchFor(doctorId), status: st, notes: a.note, mayChangeDoctor: ownSet }); // eslint-disable-line no-await-in-loop
    booked.add(a.date); visits += 1;
  }
  const days = new Map();
  rows.forEach((t) => {
    const d = dayOf(t) || (statusOf(t) === 'done' ? map.isoDay(t.complete_date) : null);
    if (!d || booked.has(d)) return;
    // one visit per day and doctor: a chair's treatments join the visit of the doctor they were given to
    const who2 = t.resolved ? `d${t.resolved}` : `n${docKey(t.doctor)}`;
    const k = `${d}|${who2}`;
    if (!days.has(k)) days.set(k, { date: d, doctorId: t.resolved, list: [] });
    days.get(k).list.push(t);
  });
  for (const v of days.values()) { // eslint-disable-line no-restricted-syntax
    const names = [...new Set(v.list.map((t) => docKey(t.doctor)))];
    // the visit's key: the Clinica name when the visit has one (as before), else its doctor here
    const keyOf = names.length === 1 ? names[0] : `doctor:${v.doctorId || ''}`;
    const notes = v.list.map((t) => {
      const desc = clean.cleanTreatment(t.description);
      const extra = [...desc.lines, String(t.note || '').trim()].filter(Boolean).join(' — ');
      return `${desc.name || t.type || 'Treatment'}${t.tooth ? ` (${t.tooth})` : ''}${extra ? `: ${extra}` : ''}`;
    }).join('\n');
    const id = await upsertVisit(db, businessId, who, { // eslint-disable-line no-await-in-loop
      key: `v:${v.date}:${crypto.createHash('sha1').update(keyOf).digest('hex').slice(0, 10)}`, date: v.date, time: null, doctorId: v.doctorId, branchId: branchFor(v.doctorId),
      status: v.date < day0 ? 'completed' : 'confirmed', notes, mayChangeDoctor: (prev) => prev === null || v.list.some((t) => t.doctor_id === prev),
    });
    const ids = v.list.map((t) => t.id);
    await db('legacy_treatments').whereIn('id', ids).update({ appointment_id: id }); // eslint-disable-line no-await-in-loop
    await db('dental_plan_items').whereIn('legacy_treatment_id', ids).whereNull('appointment_id').update({ appointment_id: id }); // eslint-disable-line no-await-in-loop
    visits += 1;
  }
  if (stats) { stats.plan_items = (stats.plan_items || 0) + made; stats.visits = (stats.visits || 0) + visits; }
  return made;
}

// ================================================================= the job
const openJob = (businessId) => knex('import_jobs').where({ business_id: businessId, type: TYPE }).whereIn('status', ['processing']).orderBy('id', 'desc').first();

/** Starts (or restarts from the beginning) the conversion of the clinic's Clinica data. */
async function start(ctx) {
  const total = Number((await knex('legacy_patients').where({ business_id: ctx.businessId, legacy_source: SOURCE }).whereNotNull('patient_id').countDistinct({ n: 'patient_id' }))[0].n);
  const cur = await openJob(ctx.businessId);
  if (cur) await knex('import_jobs').where({ id: cur.id }).update({ stage: 'cursor:0', total, processed: 0 });
  else await knex('import_jobs').insert({ business_id: ctx.businessId, type: TYPE, status: 'processing', stage: 'cursor:0', total, processed: 0, created_by: ctx.userId || null, started_at: now() });
  kick(ctx.businessId);
}

const busy = new Map();
/** Runs the clinic's conversion job in this process (no-op when it runs; taken over when its runner went quiet). */
function kick(businessId) {
  if (busy.has(businessId)) return busy.get(businessId);
  const p = tenant.runFor(businessId, () => run(businessId)).catch((e) => console.error('[legacy-promote]', e.message)).finally(() => busy.delete(businessId)); // eslint-disable-line no-console
  busy.set(businessId, p);
  return p;
}
const settle = (businessId) => busy.get(businessId) || Promise.resolve();

async function run(businessId) {
  const tz = (await knex('businesses').where({ id: businessId }).first('timezone') || {}).timezone || 'Asia/Amman';
  const today = clinicNow(tz).date;
  for (;;) {
    const job = await openJob(businessId); // eslint-disable-line no-await-in-loop
    if (!job) return;
    const stale = new Date(Date.now() - STALE_MS);
    const claimed = await knex('import_jobs').where({ id: job.id }).where((w) => w.whereNull('runner').orWhere('runner', RUNNER).orWhereNull('heartbeat_at').orWhere('heartbeat_at', '<', stale)) // eslint-disable-line no-await-in-loop
      .update({ runner: RUNNER, heartbeat_at: now() });
    if (!claimed) return;
    const cursor = Number(String(job.stage || '').replace('cursor:', '')) || 0;
    const pids = await knex('legacy_patients').where({ business_id: businessId, legacy_source: SOURCE }).whereNotNull('patient_id').where('patient_id', '>', cursor) // eslint-disable-line no-await-in-loop
      .distinct('patient_id').orderBy('patient_id').limit(100).pluck('patient_id');
    if (!pids.length) {
      const [vis] = await knex('appointments').where({ business_id: businessId, external_source: SOURCE }).count({ n: '*' }); // eslint-disable-line no-await-in-loop
      await knex('import_jobs').where({ id: job.id }).update({ status: 'completed', completed_at: now(), runner: null, heartbeat_at: null, success: Number(vis.n) }); // eslint-disable-line no-await-in-loop
      continue; // eslint-disable-line no-continue
    }
    const resolve = await resolver(knex, businessId); // eslint-disable-line no-await-in-loop
    for (const pid of pids) { // eslint-disable-line no-restricted-syntax
      await knex.transaction((trx) => promotePatient(trx, businessId, pid, { resolve: resolveIn(trx, resolve), today })); // eslint-disable-line no-await-in-loop
    }
    await knex('import_jobs').where({ id: job.id }).update({ stage: `cursor:${pids[pids.length - 1]}`, processed: knex.raw('processed + ?', [pids.length]), heartbeat_at: now() }); // eslint-disable-line no-await-in-loop
  }
}
// The resolver may create a doctor ("create" choice): inside the patient's transaction is fine — it is cached after.
const resolveIn = (trx, resolve) => resolve;

/** At start / every few minutes / when the page is opened: a conversion left by a stopped server carries on. */
async function resumeAll() {
  await tenant.eachDb(async () => {
    const open = await knex('import_jobs').where({ type: TYPE, status: 'processing' }).select('business_id').catch(() => []);
    [...new Set(open.map((j) => j.business_id))].forEach((id) => kick(id));
  });
}

/** Where the clinic's conversion is. */
async function progress(businessId) {
  const [[all], [done], [waiting], [docs], [cal], job, [unset]] = await Promise.all([
    knex('legacy_treatments').where({ business_id: businessId }).count({ n: '*' }),
    knex('legacy_treatments').where({ business_id: businessId }).whereNotNull('plan_item_id').count({ n: '*' }),
    knex('legacy_treatments').where({ business_id: businessId }).whereNull('plan_item_id').whereNull('patient_id').count({ n: '*' }),
    knex('doctors').where({ business_id: businessId, legacy_source: SOURCE }).count({ n: '*' }),
    knex('appointments').where({ business_id: businessId, external_source: SOURCE }).count({ n: '*' }),
    knex('import_jobs').where({ business_id: businessId, type: TYPE }).orderBy('id', 'desc').first(),
    knex('legacy_treatments').where({ business_id: businessId }).whereNotNull('plan_item_id').whereNull('doctor_id').count({ n: '*' }),
  ]);
  const running = Boolean(job && job.status === 'processing');
  if (running && (!job.heartbeat_at || new Date(job.heartbeat_at) < new Date(Date.now() - STALE_MS))) kick(businessId); // carry on (a stopped process)
  return {
    total: Number(all.n), done: Number(done.n), unlinked: Number(waiting.n), doctorsCreated: Number(docs.n), visits: Number(cal.n), noDoctor: Number(unset.n),
    running, patients: job ? { done: job.processed, total: job.total } : null,
  };
}

module.exports = { TYPE, promotePatient, start, kick, settle, resumeAll, progress, doctorNames, saveDoctorMap, resolver, docKey, statusOf, toothOf, timeOf };
