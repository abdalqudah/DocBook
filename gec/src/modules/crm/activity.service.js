// The single chronological timeline of a lead / student: calls, messages, notes, stage changes, tasks, documents,
// applications, payments, appointments and website activity all land here.
const knex = require('../../db/knex');

const ICONS = {
  call: ['phone', 'brand'], email: ['mail', 'info'], sms: ['message-square', 'info'], whatsapp: ['message-circle', 'ok'], meeting: ['users', 'brand'],
  note: ['sticky-note', ''], stage: ['git-merge', 'brand'], assigned: ['user-check', 'info'], task: ['list-checks', ''], document: ['file-text', 'warn'],
  application: ['graduation-cap', 'brand'], payment: ['receipt', 'ok'], appointment: ['calendar-check', 'brand'], web: ['mouse-pointer-click', ''],
  form: ['file-check', 'ok'], created: ['user-plus', 'ok'], converted: ['badge-check', 'ok'], lost: ['circle-x', 'bad'], merged: ['merge', 'info'],
  visa: ['plane', 'brand'], course: ['book-open', 'brand'], event: ['ticket', 'brand'], system: ['zap', ''], shortlist: ['bookmark', ''],
};

/**
 * Adds an activity. `who` = { leadId, studentId, applicationId }; at least one of lead / student.
 * Also bumps last_activity_at on the person.
 */
async function log(who, { type, title, body = null, meta = null, actorId = null, noteId = null, shareable = false, at = null }, trx = knex) {
  const row = {
    lead_id: who.leadId || null, student_id: who.studentId || null, application_id: who.applicationId || null,
    type, title: String(title).slice(0, 255), body, meta: meta ? JSON.stringify(meta) : null, note_id: noteId,
    actor_id: actorId, is_shareable: shareable, occurred_at: at || new Date(),
  };
  const [id] = await trx('activities').insert(row);
  const now = row.occurred_at;
  if (who.leadId) await trx('leads').where({ id: who.leadId }).update({ last_activity_at: now });
  if (who.studentId) await trx('students').where({ id: who.studentId }).update({ last_activity_at: now });
  return id;
}

/** Timeline for a person, newest first. A student's timeline includes the activity of the lead(s) it came from. */
async function timeline({ leadId, studentId, withoutStudent = false }, { limit = 200, types = null, shareableOnly = false } = {}) {
  const leadIds = [];
  if (leadId) leadIds.push(leadId);
  if (studentId) (await knex('leads').where({ student_id: studentId }).select('id')).forEach((l) => leadIds.push(l.id));
  const q = knex('activities as a').leftJoin('users as u', 'u.id', 'a.actor_id').leftJoin('notes as n', 'n.id', 'a.note_id')
    .where((w) => {
      if (leadIds.length) w.orWhereIn('a.lead_id', leadIds);
      if (studentId) w.orWhere('a.student_id', studentId);
    })
    .select('a.*', 'u.name as actor_name', 'n.body as note_body', 'n.is_shareable as note_shareable')
    .orderBy('a.occurred_at', 'desc').orderBy('a.id', 'desc').limit(limit);
  if (types && types.length) q.whereIn('a.type', types);
  if (withoutStudent) q.whereNull('a.student_id'); // lead history only, nothing recorded on the student
  if (shareableOnly) q.where('a.is_shareable', true);
  const rows = await q;
  return rows.map((r) => {
    const [icon, tone] = ICONS[r.type] || ['circle-dot', ''];
    let meta = r.meta;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    return { ...r, meta, icon, tone, body: r.note_id ? r.note_body : r.body };
  });
}

/** Groups timeline rows by day for display. */
function byDay(rows) {
  const out = [];
  let last = null;
  for (const r of rows) {
    const day = new Date(r.occurred_at).toISOString().slice(0, 10);
    if (day !== last) { out.push({ day }); last = day; }
    out.push(r);
  }
  return out;
}

module.exports = { log, timeline, byDay, ICONS };
