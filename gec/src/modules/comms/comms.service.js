// Communication delivery: every outgoing message goes through here so it is logged on the person's timeline.
// (Phase 6 adds SMS / WhatsApp providers and the communications log.)
const email = require('./email');
const activity = require('../crm/activity.service');

async function deliverEmail({ to, subject, html, text, attachments, replyTo, leadId = null, studentId = null, templateKey = null, automated = false, actorId = null }) {
  const r = await email.send({ to, subject, html, text, attachments, replyTo });
  if (leadId || studentId) {
    await activity.log({ leadId, studentId }, { type: 'email', title: 'message', meta: { direction: 'out', subject, sent: r.sent, reason: r.reason || null, template: templateKey, automated }, actorId });
  }
  return r;
}

module.exports = { deliverEmail };
