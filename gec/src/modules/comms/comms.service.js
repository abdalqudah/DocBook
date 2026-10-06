// Communication delivery and the message log. Every outgoing message (manual or automated, any channel) goes
// through send(): it is delivered by the channel's provider, stored in `messages` and added to the person's
// timeline. Inbound messages from provider webhooks are matched to a lead / student (or create a lead).
const knex = require('../../db/knex');
const events = require('../../core/events');
const email = require('./email');
const sms = require('./sms');
const whatsapp = require('./whatsapp');
const activity = require('../crm/activity.service');

const PROVIDERS = { email, sms, whatsapp };

async function personBranch(leadId, studentId) {
  if (studentId) { const s = await knex('students').where({ id: studentId }).first('branch_id'); if (s) return s.branch_id; }
  if (leadId) { const l = await knex('leads').where({ id: leadId }).first('branch_id'); if (l) return l.branch_id; }
  return null;
}

async function record({ channel, direction = 'out', status, leadId, studentId, to, from, subject, body, templateKey, automated, provider, providerMessageId, error, actorId }) {
  const [id] = await knex('messages').insert({
    channel, direction, status, lead_id: leadId || null, student_id: studentId || null, to_address: to ? String(to).slice(0, 190) : null, from_address: from ? String(from).slice(0, 190) : null,
    subject: subject ? String(subject).slice(0, 255) : null, body: body || null, template_key: templateKey || null, automated: !!automated, provider: provider || null,
    provider_message_id: providerMessageId || null, error: error ? String(error).slice(0, 500) : null, sent_by: actorId || null, branch_id: await personBranch(leadId, studentId),
  });
  if (leadId || studentId) {
    await activity.log({ leadId, studentId }, { type: channel, title: 'message', body: channel === 'email' ? null : (body ? String(body).slice(0, 2000) : null), meta: { direction, subject: subject || null, sent: ['sent', 'received', 'manual', 'delivered', 'read'].includes(status), manual: status === 'manual', reason: error || null, template: templateKey || null, automated: !!automated, message_id: id }, actorId: actorId || null });
  }
  return id;
}

/**
 * Sends a message. channel: email | sms | whatsapp. For e-mail, `html` is optional (the branded layout is applied
 * to `body` otherwise). Returns { sent, reason?, id }.
 */
async function send({ channel = 'email', to, subject = null, body, html = null, attachments = null, replyTo = null, headers = null, leadId = null, studentId = null, templateKey = null, automated = false, actorId = null, locale = 'en' }) {
  if (!PROVIDERS[channel] && channel !== 'portal') throw new Error(`Unknown channel ${channel}`);
  let r;
  if (channel === 'portal') {
    r = { sent: true, to: 'portal' }; // stored and shown in the student's portal inbox (with a notification)
  } else if (channel === 'email') {
    const htmlBody = html || await email.layout({ locale, title: subject, body });
    r = await email.send({ to, subject, html: htmlBody, text: body, attachments, replyTo, headers });
  } else {
    r = await PROVIDERS[channel].send({ to, body });
  }
  const status = r.sent ? 'sent' : (r.reason === 'not_configured' ? 'not_configured' : 'failed');
  const id = await record({ channel, status, leadId, studentId, to: r.to || to, subject, body, templateKey, automated, provider: { email: 'smtp', sms: 'twilio', whatsapp: 'whatsapp_cloud', portal: 'portal' }[channel], providerMessageId: r.messageId, error: r.sent ? null : r.reason, actorId });
  await events.emit('message.sent', { id, channel, status, leadId, studentId });
  return { sent: !!r.sent, reason: r.reason || null, id };
}

/** Backwards-compatible e-mail helper used by notifications. */
async function deliverEmail({ to, subject, html, text, attachments, replyTo, leadId = null, studentId = null, templateKey = null, automated = false, actorId = null }) {
  return send({ channel: 'email', to, subject, body: text, html, attachments, replyTo, leadId, studentId, templateKey, automated, actorId });
}

/** A message sent outside the system (e.g. WhatsApp click-to-chat from the staff member's phone). */
async function logManual({ channel, to, body, leadId, studentId, actorId }) {
  return record({ channel, status: 'manual', leadId, studentId, to, body, actorId, provider: 'manual' });
}

/** Inbound message from a webhook: match by phone / e-mail, else create a lead (source = channel). */
async function receive({ channel, from, name = null, body, providerMessageId = null, subject = null }) {
  if (providerMessageId && await knex('messages').where({ provider_message_id: providerMessageId, direction: 'in' }).first('id')) return null; // retries
  const people = require('../crm/people'); // eslint-disable-line global-require
  const tail = channel === 'email' ? null : people.phoneTail(from);
  const addr = channel === 'email' ? String(from).toLowerCase() : null;
  const match = (table) => knex(table).where((w) => { if (tail) w.where('phone_tail', tail); else w.where('email', addr); }).whereNot((w) => (table === 'students' ? w.whereNotNull('merged_into_id') : w.where('status', 'merged'))).orderBy('id', 'desc').first();
  let student = await match('students');
  let lead = student ? await knex('leads').where({ student_id: student.id }).orderBy('id', 'desc').first() : await match('leads');
  if (!student && lead && lead.student_id) student = await knex('students').where({ id: lead.student_id }).first();
  if (!student && !lead) {
    const leads = require('../crm/leads.service'); // eslint-disable-line global-require
    const nm = people.splitName(name || '');
    ({ lead } = await leads.capture({ userId: null }, { first_name: nm.first_name || from, last_name: nm.last_name, phone: channel === 'email' ? null : from, whatsapp: channel === 'whatsapp' ? from : null, email: addr, message: body }, { source: channel === 'whatsapp' ? 'whatsapp' : (channel === 'sms' ? 'phone' : 'contact_form'), consent: { contact: true } }));
  }
  const id = await record({ channel, direction: 'in', status: 'received', leadId: lead ? lead.id : null, studentId: student ? student.id : null, from, subject, body, provider: channel, providerMessageId });
  await events.emit('message.received', { id, channel, leadId: lead ? lead.id : null, studentId: student ? student.id : null });
  return id;
}

/** A student writes to GEC from the portal. */
async function fromStudent(studentId, body, userId) {
  const lead = await knex('leads').where({ student_id: studentId }).orderBy('id', 'desc').first('id');
  const id = await record({ channel: 'portal', direction: 'in', status: 'received', studentId, leadId: lead ? lead.id : null, from: 'portal', body, provider: 'portal', actorId: userId });
  await events.emit('message.received', { id, channel: 'portal', leadId: lead ? lead.id : null, studentId });
  return id;
}

/** Delivery receipts (delivered / read / failed) from providers. */
async function updateStatus(providerMessageId, status, error = null) {
  if (!providerMessageId || !['delivered', 'read', 'failed', 'sent'].includes(status)) return;
  await knex('messages').where({ provider_message_id: providerMessageId, direction: 'out' }).whereNot('status', 'read').update({ status, ...(error ? { error: String(error).slice(0, 500) } : {}) });
}

/** Messages visible to a staff member (their data scope applies through the lead / student). */
function base(staff) {
  const q = knex('messages as m').leftJoin('leads as l', 'l.id', 'm.lead_id').leftJoin('students as s', 's.id', 'm.student_id').leftJoin('users as u', 'u.id', 'm.sent_by');
  const { dataScope, id: empId, branchId } = staff.employee;
  if (dataScope === 'all') return q;
  return q.where((w) => {
    w.where('s.counsellor_id', empId).orWhere('l.counsellor_id', empId);
    if (dataScope === 'branch' && branchId) w.orWhere('m.branch_id', branchId);
  });
}
const COLS = ['m.*', 'l.first_name as lead_first', 'l.last_name as lead_last', 's.first_name as student_first', 's.last_name as student_last', 'u.name as sender_name'];

async function unreadCount(staff) {
  const [{ n }] = await base(staff).where('m.direction', 'in').whereNull('m.read_at').count({ n: '*' });
  return Number(n);
}

module.exports = { send, deliverEmail, logManual, receive, fromStudent, updateStatus, base, COLS, unreadCount, record };
