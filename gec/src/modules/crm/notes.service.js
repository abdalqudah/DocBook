// Internal notes with @mentions. Private to staff unless marked shareable (then the student sees it in the portal).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const activity = require('./activity.service');

/** Finds @mentions: "@Sarah Jones" matches an active employee by full name (or first name when unique). */
async function resolveMentions(body) {
  const tokens = [...String(body).matchAll(/@([\p{L}][\p{L}\p{M}'.-]*(?:\s[\p{L}][\p{L}\p{M}'.-]*)?)/gu)].map((m) => m[1].toLowerCase());
  if (!tokens.length) return [];
  const staff = await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('u.status', 'active').select('e.id', 'u.name');
  const ids = new Set();
  for (const tok of tokens) {
    const full = staff.filter((s) => s.name.toLowerCase() === tok || tok.startsWith(s.name.toLowerCase()));
    if (full.length) { full.forEach((s) => ids.add(s.id)); continue; } // eslint-disable-line no-continue
    const firstWord = tok.split(' ')[0];
    const byFirst = staff.filter((s) => s.name.toLowerCase().split(' ')[0] === firstWord);
    if (byFirst.length === 1) ids.add(byFirst[0].id);
  }
  return [...ids];
}

async function add(ctx, { leadId = null, studentId = null, applicationId = null }, { body, shareable = false }) {
  const text = String(body || '').trim();
  if (!text) throw E.validation({ body: 'Required.' });
  if (text.length > 10000) throw E.validation({ body: 'Too long.' });
  const mentions = await resolveMentions(text);
  const [id] = await knex('notes').insert({ lead_id: leadId, student_id: studentId, application_id: applicationId, body: text, is_shareable: Boolean(shareable), mentions: JSON.stringify(mentions), author_id: ctx.userId });
  await activity.log({ leadId, studentId, applicationId }, { type: 'note', title: 'note', noteId: id, actorId: ctx.userId, shareable: Boolean(shareable) });
  await audit.record(ctx, 'note.created', { entityType: 'note', entityId: id, newValues: { lead_id: leadId, student_id: studentId, application_id: applicationId, shareable: Boolean(shareable) } });
  if (mentions.length) await events.emit('note.mentioned', { noteId: id, employeeIds: mentions, leadId, studentId, applicationId, by: ctx.userId, body: text });
  return id;
}

async function remove(ctx, noteId, { canModerate = false } = {}) {
  const n = await knex('notes').where({ id: noteId }).first();
  if (!n) throw E.notFound('Note');
  if (n.author_id !== ctx.userId && !canModerate) throw E.forbidden();
  await knex('notes').where({ id: noteId }).del(); // its timeline entry goes with it (FK cascade)
  await audit.record(ctx, 'note.deleted', { entityType: 'note', entityId: noteId, oldValues: { body: n.body.slice(0, 500) } });
  return n;
}

module.exports = { add, remove, resolveMentions };
