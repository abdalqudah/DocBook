// Surgeries (Patients → Surgeries): a doctor blocks time in the calendar and marks it as an operation — patient,
// procedure, hospital. The block keeps the doctor's time; this row keeps the operation (and a copy of its date,
// time, length and doctor, so a cancelled surgery stays in the list and a moved block moves it).
//   fromBlock(trx, ctx, block, input) — called by appointments.block() when the block is a surgery
//   list(ctx, filters) / get(ctx, id) / update(ctx, id, input) / setStatus(ctx, id, status)
//   message(ctx, s, locale) — the e-mail / WhatsApp text for the hospital (clinic's own wording, Settings → Message texts)
//   markSent(ctx, s, channel, to)
// A doctor login sees and changes only their own surgeries.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');

const STATUSES = ['scheduled', 'done', 'cancelled'];
const id = () => z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional());
const schema = z.object({
  patient_id: id(),
  patient_name: optionalString(190),
  patient_phone: optionalString(40),
  procedure_name: z.string().trim().min(1, 'Required.').max(190, 'Too long.'),
  hospital_id: id(),
  hospital_name: optionalString(190),
  notes: optionalString(2000),
});

/** The form as the schema reads it ("other hospital" in the list = a typed name). */
const clean = (input = {}) => ({ ...input, hospital_id: /^\d+$/.test(String(input.hospital_id || '')) ? input.hospital_id : '' });

/** The patient and hospital of a surgery form, checked against this clinic. */
async function resolve(db, ctx, d) {
  let patient = null;
  if (d.patient_id) {
    patient = await db('patients').where({ id: d.patient_id, business_id: ctx.businessId }).first('id', 'full_name', 'phone');
    if (!patient) throw E.validation({ patient_id: 'Choose a patient.' });
  }
  const name = (patient && patient.full_name) || d.patient_name;
  if (!name) throw E.validation({ patient_name: 'Required.' });
  let hospital = null;
  if (d.hospital_id) {
    hospital = await db('clinic_partners').where({ id: d.hospital_id, business_id: ctx.businessId, kind: 'hospital' }).first('id', 'name');
    if (!hospital) throw E.validation({ hospital_id: 'Choose a hospital.' });
  }
  return {
    patient_id: patient ? patient.id : null, patient_name: name, patient_phone: d.patient_phone || (patient && patient.phone) || null,
    procedure_name: d.procedure_name, hospital_id: hospital ? hospital.id : null, hospital_name: hospital ? hospital.name : (d.hospital_name || null), notes: d.notes || null,
  };
}

/** The calendar label of a surgery block: "Procedure — Patient". */
const labelOf = (s) => `${s.procedure_name} — ${s.patient_name}`.slice(0, 190);

/** Creates the surgery of a new time block (inside the block's transaction) → the surgery row's fields. */
async function fromBlock(trx, ctx, block, input) {
  const d = await resolve(trx, ctx, validate(schema, clean(input)));
  const row = {
    business_id: ctx.businessId, appointment_id: block.id, doctor_id: block.doctor_id, surgery_date: block.appointment_date, surgery_time: block.appointment_time,
    duration_minutes: block.duration_minutes || null, ...d, status: 'scheduled', created_by: ctx.userId,
  };
  const [sid] = await trx('surgeries').insert(row);
  await audit.record(ctx, 'surgery.created', { entityType: 'surgery', entityId: sid, newValues: { appointment_id: block.id, procedure: d.procedure_name, hospital: d.hospital_name, patient_id: d.patient_id } }, trx);
  return { id: sid, ...row };
}
/** Validates a surgery form before the block is made (so a bad form never reserves time). */
const check = (ctx, input) => resolve(knex, ctx, validate(schema, clean(input)));

const base = (ctx) => {
  const q = knex('surgeries as s').leftJoin('doctors as d', 'd.id', 's.doctor_id').leftJoin('clinic_partners as h', 'h.id', 's.hospital_id')
    .where('s.business_id', ctx.businessId)
    .select('s.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'h.email as hospital_email', 'h.phone as hospital_phone');
  if (ctx.ownDoctorId) q.where('s.doctor_id', ctx.ownDoctorId);
  if (ctx.workBranch) q.whereIn('s.doctor_id', require('../clinic/branches.service').doctorIds(ctx)); // eslint-disable-line global-require -- the branch's doctors
  return q;
};

/** filters: when = upcoming | past | all, doctor, hospital, status. */
async function list(ctx, f = {}) {
  const q = base(ctx);
  const today = ctx.today || new Date().toISOString().slice(0, 10);
  if (f.when === 'past') q.where('s.surgery_date', '<', today).orderBy([{ column: 's.surgery_date', order: 'desc' }, { column: 's.surgery_time', order: 'desc' }]);
  else if (f.when === 'all') q.orderBy([{ column: 's.surgery_date', order: 'desc' }, { column: 's.surgery_time', order: 'desc' }]);
  else q.where('s.surgery_date', '>=', today).orderBy([{ column: 's.surgery_date' }, { column: 's.surgery_time' }]);
  if (Number(f.doctor)) q.where('s.doctor_id', Number(f.doctor));
  if (Number(f.hospital)) q.where('s.hospital_id', Number(f.hospital));
  if (STATUSES.includes(f.status)) q.where('s.status', f.status);
  else if (f.when !== 'all' && f.when !== 'past') q.whereNot('s.status', 'cancelled');
  return q.limit(500);
}

/** Surgeries between two dates (calendar views), cancelled ones left out unless asked. */
async function range(ctx, from, to, f = {}) {
  const q = base(ctx).where('s.surgery_date', '>=', from).where('s.surgery_date', '<=', to).orderBy([{ column: 's.surgery_date' }, { column: 's.surgery_time' }]);
  if (Number(f.doctor)) q.where('s.doctor_id', Number(f.doctor));
  if (Number(f.hospital)) q.where('s.hospital_id', Number(f.hospital));
  if (!f.cancelled) q.whereNot('s.status', 'cancelled');
  return q.select('d.color as doctor_color');
}

/** A patient's surgeries (patient page), newest first. */
async function forPatient(ctx, patientId) {
  return base(ctx).where('s.patient_id', Number(patientId) || 0).orderBy([{ column: 's.surgery_date', order: 'desc' }, { column: 's.surgery_time', order: 'desc' }]).limit(100);
}

async function get(ctx, sid) {
  const s = await base(ctx).where('s.id', Number(sid) || 0).first();
  if (!s) throw E.notFound('Surgery');
  return s;
}

async function update(ctx, sid, input) {
  const s = await get(ctx, sid);
  const d = await resolve(knex, ctx, validate(schema, clean(input)));
  await knex.transaction(async (trx) => {
    await trx('surgeries').where({ id: s.id, business_id: ctx.businessId }).update({ ...d, updated_at: new Date() });
    if (s.appointment_id) await trx('appointments').where({ id: s.appointment_id, business_id: ctx.businessId, appointment_type: 'blocked' }).update({ patient_name: labelOf(d), notes: labelOf(d), updated_at: new Date() });
    await audit.record(ctx, 'surgery.updated', { entityType: 'surgery', entityId: s.id, oldValues: { procedure: s.procedure_name, hospital: s.hospital_name, patient_id: s.patient_id }, newValues: { procedure: d.procedure_name, hospital: d.hospital_name, patient_id: d.patient_id } }, trx);
  });
}

/** done / cancelled / scheduled again. Cancelling frees the doctor's time (the block is removed). */
async function setStatus(ctx, sid, status) {
  if (!STATUSES.includes(status)) throw E.validation({ status: 'Choose a valid value.' });
  const s = await get(ctx, sid);
  if (status === 'scheduled' && s.status === 'cancelled' && !s.appointment_id) throw new AppError('SURGERY_NO_TIME', 'Book the time again from the calendar.', 409);
  await knex.transaction(async (trx) => {
    await trx('surgeries').where({ id: s.id }).update({ status, updated_at: new Date(), ...(status === 'cancelled' ? { appointment_id: null } : {}) });
    if (status === 'cancelled' && s.appointment_id) await trx('appointments').where({ id: s.appointment_id, business_id: ctx.businessId, appointment_type: 'blocked' }).del();
    await audit.record(ctx, `surgery.${status}`, { entityType: 'surgery', entityId: s.id, oldValues: { status: s.status }, newValues: { status } }, trx);
  });
}

/** Keeps the surgery with its block when the block is moved in the calendar (appointments.move). */
async function followBlock(trx, ctx, blockId, d) {
  await trx('surgeries').where({ business_id: ctx.businessId, appointment_id: blockId })
    .update({ surgery_date: d.appointment_date, surgery_time: d.appointment_time, doctor_id: d.doctor_id, updated_at: new Date() });
}
/** The block was deleted from the calendar: the surgery is cancelled (kept in the list). */
async function blockRemoved(trx, ctx, blockId) {
  await trx('surgeries').where({ business_id: ctx.businessId, appointment_id: blockId }).whereNot('status', 'done').update({ status: 'cancelled', appointment_id: null, updated_at: new Date() });
  await trx('surgeries').where({ business_id: ctx.businessId, appointment_id: blockId }).update({ appointment_id: null });
}

/** The message to the hospital → { subject, body, wa } in `locale`, with the clinic's own wording. */
async function message(ctx, s, clinic, locale) {
  const texts = require('../messaging/texts.service'); // eslint-disable-line global-require
  const { formatDate } = require('../../core/format'); // eslint-disable-line global-require
  const t = await texts.translatorFor(ctx.businessId, locale);
  const iso = (v) => (locale === 'ar' && v ? `⁦${v}⁩` : v);
  let date = String(s.surgery_date);
  try { date = formatDate(s.surgery_date, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); } catch { /* plain date */ }
  const end = s.duration_minutes ? (() => { const [h, m] = String(s.surgery_time).split(':').map(Number); const x = h * 60 + m + Number(s.duration_minutes); return `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; })() : null;
  const vars = {
    hospital: s.hospital_name || '', clinic: (locale === 'en' && clinic.name_en) || clinic.name, doctor: (locale === 'en' && s.doctor_name_en) || s.doctor_name || '',
    name: s.patient_name, phone: s.patient_phone ? iso(s.patient_phone) : '—', procedure: s.procedure_name, date, time: iso(end ? `${s.surgery_time}–${end}` : s.surgery_time),
    notes: s.notes || '—',
  };
  return { subject: t('surgeries.msg.mail_subject', vars), body: t('surgeries.msg.mail_body', vars), wa: t('surgeries.msg.wa', vars), vars };
}

async function markSent(ctx, s, channel, to) {
  await knex('surgeries').where({ id: s.id, business_id: ctx.businessId }).update({ sent_at: new Date(), sent_to: String(to).slice(0, 190), sent_channel: channel, updated_at: new Date() });
  await audit.record(ctx, 'surgery.sent', { entityType: 'surgery', entityId: s.id, newValues: { channel, to: String(to).slice(0, 190) } });
}

module.exports = { STATUSES, schema, check, labelOf, fromBlock, list, range, forPatient, get, update, setStatus, followBlock, blockRemoved, message, markSent };
