// Consultation timer: when the doctor actually started and finished the consultation of a visit (with pauses).
// Start and stop are idempotent: starting a running (or finished) consultation keeps the original start time,
// stopping a finished one keeps the original end time. Every change is audited.
const knex = require('../../db/knex');
const audit = require('../../core/audit');

const toMs = (d) => (d ? new Date(d).getTime() : null);

/** Seconds of actual consultation: (end or now) − start − paused time (including a pause still running). */
function durationSeconds(t, now = new Date()) {
  if (!t || !t.started_at) return 0;
  const end = toMs(t.ended_at) || toMs(now);
  const pausedNow = t.paused_at && !t.ended_at ? Math.max(0, toMs(now) - toMs(t.paused_at)) : 0;
  return Math.max(0, Math.round((end - toMs(t.started_at) - pausedNow) / 1000) - Number(t.paused_seconds || 0));
}

function stateOf(t) {
  if (!t) return 'idle';
  if (t.ended_at) return 'done';
  return t.paused_at ? 'paused' : 'running';
}

/** Public shape for the page and the JSON endpoint. */
function view(t, now = new Date()) {
  return {
    state: stateOf(t), startedAt: t ? new Date(t.started_at).toISOString() : null, endedAt: t && t.ended_at ? new Date(t.ended_at).toISOString() : null,
    pausedAt: t && t.paused_at && !t.ended_at ? new Date(t.paused_at).toISOString() : null, pausedSeconds: t ? Number(t.paused_seconds || 0) : 0,
    seconds: durationSeconds(t, now), now: now.toISOString(),
  };
}

const get = (businessId, appointmentId) => knex('consultation_timers').where({ business_id: businessId, appointment_id: appointmentId }).first();

async function start(ctx, appt, now = new Date()) {
  const existing = await get(ctx.businessId, appt.id);
  if (existing) return existing; // idempotent: never moves the start time
  try {
    await knex('consultation_timers').insert({ business_id: ctx.businessId, appointment_id: appt.id, doctor_id: appt.doctor_id || null, started_at: now, started_by: ctx.userId });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return get(ctx.businessId, appt.id); // a parallel request won the race
    throw err;
  }
  await audit.record(ctx, 'consultation.timer_started', { entityType: 'appointment', entityId: appt.id, newValues: { started_at: now.toISOString() } });
  return get(ctx.businessId, appt.id);
}

async function pause(ctx, appt, now = new Date()) {
  const n = await knex('consultation_timers').where({ business_id: ctx.businessId, appointment_id: appt.id }).whereNull('ended_at').whereNull('paused_at').update({ paused_at: now });
  if (n) await audit.record(ctx, 'consultation.timer_paused', { entityType: 'appointment', entityId: appt.id });
  return get(ctx.businessId, appt.id);
}

async function resume(ctx, appt, now = new Date()) {
  await knex.transaction(async (trx) => {
    const t = await trx('consultation_timers').where({ business_id: ctx.businessId, appointment_id: appt.id }).forUpdate().first();
    if (!t || t.ended_at || !t.paused_at) return;
    const add = Math.max(0, Math.round((toMs(now) - toMs(t.paused_at)) / 1000));
    await trx('consultation_timers').where({ id: t.id }).update({ paused_at: null, paused_seconds: Number(t.paused_seconds || 0) + add });
    await audit.record(ctx, 'consultation.timer_resumed', { entityType: 'appointment', entityId: appt.id }, trx);
  });
  return get(ctx.businessId, appt.id);
}

/** Stops a running consultation (a running pause is closed first). No timer or already stopped: unchanged. */
async function stop(ctx, appt, now = new Date()) {
  let changed = null;
  await knex.transaction(async (trx) => {
    const t = await trx('consultation_timers').where({ business_id: ctx.businessId, appointment_id: appt.id }).forUpdate().first();
    if (!t || t.ended_at) return;
    const add = t.paused_at ? Math.max(0, Math.round((toMs(now) - toMs(t.paused_at)) / 1000)) : 0;
    const patch = { ended_at: now, ended_by: ctx.userId, paused_at: null, paused_seconds: Number(t.paused_seconds || 0) + add };
    await trx('consultation_timers').where({ id: t.id }).update(patch);
    changed = { ...t, ...patch };
    await audit.record(ctx, 'consultation.timer_stopped', { entityType: 'appointment', entityId: appt.id, newValues: { minutes: Math.round(durationSeconds(changed, now) / 6) / 10 } }, trx);
  });
  return get(ctx.businessId, appt.id);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Suggested slot length: the median rounded up to 5 minutes (at least 5). */
const suggestSlot = (medianMinutes) => (medianMinutes ? Math.max(5, Math.ceil(medianMinutes / 5) * 5) : null);

module.exports = { get, start, pause, resume, stop, durationSeconds, stateOf, view, median, suggestSlot };
