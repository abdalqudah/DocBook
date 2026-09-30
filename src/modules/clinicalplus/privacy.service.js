// Medical-record privacy and the record-access log.
//
// The rule (clinic setting "Only the treating doctor can open clinical notes", businesses.clinical_privacy):
//   • Setting OFF → unchanged behaviour: anyone holding clinical.view sees the clinical record.
//   • Setting ON  → the clinical record of a patient (SOAP notes, coded diagnoses, prescriptions, vitals history,
//     specialty records, documents) opens only for:
//       1. the owner / clinic manager (role owner or clinic_manager, or any role holding settings.manage);
//       2. a doctor login (a membership linked to a doctor profile) that has treated the patient or has a booking
//          with them (any appointment that is not cancelled);
//       3. a staff member with an active emergency ("break-glass") grant for this patient (24 hours).
//     Anyone else sees the patient's basic details only. A nurse (vitals.edit without a doctor profile) keeps
//     access to the vital signs of the visit. Allergies and chronic conditions stay visible (patient safety).
//   • Break-glass: a restricted staff member holding clinical.edit may open the record for 24 hours after typing a
//     reason; the grant is logged, audited and notified to the clinic owner(s).
// Every page view of a patient's record or a visit is written to record_access_log (one row per view).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const notifications = require('../notifications/notification.service');
const { translator } = require('../../core/i18n');
const { z, validate } = require('../../core/validate');
const { AppError } = require('../../core/errors');

const GRANT_HOURS = 24;

async function isOn(businessId) {
  const b = await knex('businesses').where({ id: businessId }).first('clinical_privacy');
  return Boolean(b && b.clinical_privacy);
}

const isManager = (ctx) => ['owner', 'clinic_manager'].includes(ctx.roleKey) || ctx.permissions.has('settings.manage');

const activeGrant = (ctx, patientId, now = new Date()) => knex('record_access_grants')
  .where({ business_id: ctx.businessId, patient_id: patientId, user_id: ctx.userId }).where('expires_at', '>', now)
  .orderBy('expires_at', 'desc').first('id', 'reason', 'expires_at', 'created_at');

async function treats(ctx, patientId) {
  if (!ctx.doctorId || !patientId) return false;
  const row = await knex('appointments').where({ business_id: ctx.businessId, patient_id: patientId, doctor_id: ctx.doctorId })
    .whereNot('status', 'cancelled').whereNot('appointment_type', 'blocked').first('id');
  return Boolean(row);
}

/**
 * What the signed-in member may see of a patient's clinical record.
 * @param {object} ctx       request context
 * @param {object} opts      { patientId, appointment } — appointment: the visit being opened (optional)
 * @returns {{ clinical: boolean, vitals: boolean, reason: string, grant: object|null, canBreakGlass: boolean, enforced: boolean }}
 *   reason: no_permission | open | manager | treating | emergency | restricted
 */
async function access(ctx, { patientId = null, appointment = null } = {}) {
  const perms = ctx.permissions;
  const vitalsPerm = perms.has('vitals.edit');
  if (!perms.has('clinical.view')) return { clinical: false, vitals: vitalsPerm, reason: 'no_permission', grant: null, canBreakGlass: false, enforced: false };
  if (!(await isOn(ctx.businessId))) return { clinical: true, vitals: vitalsPerm, reason: 'open', grant: null, canBreakGlass: false, enforced: false };
  const full = (reason, grant = null) => ({ clinical: true, vitals: vitalsPerm, reason, grant, canBreakGlass: false, enforced: true });
  if (isManager(ctx)) return full('manager');
  const pid = patientId || (appointment && appointment.patient_id) || null;
  if (ctx.doctorId && appointment && appointment.doctor_id === ctx.doctorId) return full('treating');
  if (await treats(ctx, pid)) return full('treating');
  if (pid) { const g = await activeGrant(ctx, pid); if (g) return full('emergency', g); }
  // Walk-in visit without a patient file: the record is this single visit — its own doctor only (above).
  return { clinical: false, vitals: vitalsPerm && !ctx.doctorId, reason: 'restricted', grant: null, canBreakGlass: Boolean(pid) && perms.has('clinical.edit'), enforced: true };
}

/** One row per page view. Never breaks the page. */
async function log(ctx, { patientId = null, appointmentId = null, what, access: level }) {
  try {
    await knex('record_access_log').insert({
      business_id: ctx.businessId, user_id: ctx.userId || null, patient_id: patientId || null, appointment_id: appointmentId || null,
      what, access: level, ip: ctx.ip ? String(ctx.ip).slice(0, 64) : null,
    });
  } catch (err) { /* logging must not block care */ }
}
const levelOf = (acc) => (acc.reason === 'emergency' ? 'emergency' : acc.clinical ? 'full' : 'limited');

/** Break-glass: grants this member 24 h of access to one patient's record. */
async function breakGlass(ctx, patient, input, now = new Date()) {
  const d = validate(z.object({ reason: z.string().trim().min(10, 'Too short.').max(500, 'Too long.') }), input);
  const acc = await access(ctx, { patientId: patient.id });
  if (acc.clinical) return acc.grant || null; // nothing to unlock
  if (!acc.canBreakGlass) throw new AppError('EMERGENCY_NOT_ALLOWED', 'You cannot request emergency access.', 403);
  const expires = new Date(now.getTime() + GRANT_HOURS * 3600 * 1000);
  const [id] = await knex('record_access_grants').insert({ business_id: ctx.businessId, patient_id: patient.id, user_id: ctx.userId, reason: d.reason, expires_at: expires, created_at: now });
  await log(ctx, { patientId: patient.id, what: 'break_glass', access: 'emergency' });
  await audit.record(ctx, 'record.emergency_access', { entityType: 'patient', entityId: patient.id, newValues: { reason: d.reason, expires_at: expires.toISOString() } });
  // Tell the owner(s), each in their own language.
  const owners = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').join('users as u', 'u.id', 'm.user_id')
    .where({ 'm.business_id': ctx.businessId, 'r.key': 'owner', 'm.status': 'active' }).select('u.id', 'u.locale');
  for (const o of owners) {
    if (o.id === ctx.userId) continue; // eslint-disable-line no-continue
    const t = translator(o.locale || 'ar');
    await notifications.notify(ctx.businessId, { // eslint-disable-line no-await-in-loop
      userId: o.id, type: 'record.emergency', severity: 'warning',
      title: t('privacy.notify_title', { name: ctx.userName || '—', patient: patient.full_name }),
      body: d.reason.slice(0, 900), link: `/app/settings/privacy/log?patient=${patient.id}`, dedupeKey: `bg:${id}:${o.id}`,
    });
  }
  return { id, reason: d.reason, expires_at: expires };
}

// ---------------------------------------------------------------- log page
function logQuery(ctx, q) {
  const qb = knex('record_access_log as l').leftJoin('users as u', 'u.id', 'l.user_id').leftJoin('patients as p', 'p.id', 'l.patient_id')
    .where('l.business_id', ctx.businessId);
  if (/^\d+$/.test(q.user || '')) qb.where('l.user_id', Number(q.user));
  if (/^\d+$/.test(q.patient || '')) qb.where('l.patient_id', Number(q.patient));
  if (q.what && ['patient', 'visit', 'break_glass'].includes(q.what)) qb.where('l.what', q.what);
  if (q.q && String(q.q).trim()) qb.where('p.full_name', 'like', `%${String(q.q).trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
  return qb;
}

module.exports = { GRANT_HOURS, isOn, isManager, access, log, levelOf, breakGlass, activeGrant, logQuery };
