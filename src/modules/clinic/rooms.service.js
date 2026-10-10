// The clinic (room / chair) number each doctor works in on a day (doctor_day_rooms), else the doctor's usual room
// (doctors.room). Set by reception on the calendar / front desk; shown on the waiting-room screen.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');

const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
const clean = (v) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 20) || null;

/** Map doctor id → room number on a day (the day's, else the usual one). */
async function roomsOn(businessId, day) {
  const [docs, set] = await Promise.all([
    knex('doctors').where({ business_id: businessId }).select('id', 'room'),
    knex('doctor_day_rooms').where({ business_id: businessId, day: dayOf(day) }).select('doctor_id', 'room').catch(() => []),
  ]);
  const m = new Map(docs.filter((d) => d.room).map((d) => [d.id, d.room]));
  set.forEach((r) => { if (r.room) m.set(r.doctor_id, r.room); else m.delete(r.doctor_id); });
  return m;
}

/** The doctor's room on that day ('' = none that day); audited. */
async function setRoom(ctx, doctorId, day, room) {
  const d = await knex('doctors').where({ id: Number(doctorId) || 0, business_id: ctx.businessId }).first('id', 'room');
  if (!d) throw E.notFound('Doctor');
  const v = clean(room);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : null;
  if (!date) throw E.validation({ day: 'Enter a valid date.' });
  await knex('doctor_day_rooms').insert({ business_id: ctx.businessId, doctor_id: d.id, day: date, room: v, set_by: ctx.userId || null })
    .onConflict(['doctor_id', 'day']).merge({ room: v, set_by: ctx.userId || null, updated_at: new Date() });
  await audit.record(ctx, 'doctor.room', { entityType: 'doctor', entityId: d.id, newValues: { day: date, room: v } });
  return v;
}

/** The assistants / nurses of each room (memberships.room), of the branch the member works in: Map room → [names]. */
async function assistantsByRoom(ctx) {
  const q = knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.business_id': ctx.businessId, 'm.status': 'active' })
    .whereNotNull('m.room').whereNot('m.room', '').whereNull('m.doctor_id').select('m.room', 'u.name');
  if (ctx.workBranch) q.where((w) => w.where('m.work_branch', String(ctx.workBranch)).orWhere('m.work_branch', ''));
  const map = new Map();
  (await q.catch(() => [])).forEach((r) => { const k = String(r.room).trim(); if (!map.has(k)) map.set(k, []); map.get(k).push(r.name); });
  return map;
}

module.exports = { roomsOn, setRoom, assistantsByRoom, clean };
