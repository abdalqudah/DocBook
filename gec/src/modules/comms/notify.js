// Sends a templated message to a person (lead, student or registrant) over e-mail, and records it on their timeline.
// Phase 6 routes SMS / WhatsApp through the same call and logs every message in the communications table.
const knex = require('../../db/knex');
const email = require('./email');
const templates = require('./templates');
const settings = require('../settings/settings.service');

/**
 * to: { email, name, locale, leadId, studentId }; vars: template variables; link: button target.
 * Returns { sent, reason }. Never throws for delivery problems (they are logged).
 */
// Which notification category each template belongs to (students can switch e-mail off per category).
const CATEGORY = {
  consultation_confirmation: 'appointments', appointment_reminder: 'appointments', missing_documents: 'documents', document_rejected: 'documents',
  application_submitted: 'applications', offer_received: 'applications', application_status: 'applications', visa_update: 'visa', course_registration: 'events',
  event_registration: 'events', event_reminder: 'events', event_follow_up: 'events', payment_confirmation: 'payments', invoice_issued: 'payments', new_message: 'messages',
};

async function sendTemplate(key, to, vars = {}, { link = null, attachments = null } = {}) {
  if (!to || !to.email) return { sent: false, reason: 'no_address' };
  if (to.studentId && CATEGORY[key] && await knex.schema.hasTable('notifications')) {
    const prefs = require('../notifications/service'); // eslint-disable-line global-require
    if (!(await prefs.allowed(to.studentId, CATEGORY[key], 'email'))) return { sent: false, reason: 'opted_out' };
  }
  const locale = to.locale === 'ar' ? 'ar' : 'en';
  const branding = await settings.get('branding');
  const all = { company_name: branding.legal_name, student_name: to.name || '', ...vars };
  const msg = await templates.render(key, locale, all);
  if (!msg) return { sent: false, reason: 'no_template' };
  try {
    const html = await email.layout({ locale, title: msg.subject, body: msg.body, cta: link ? msg.cta : null, href: link });
    const comms = require('./comms.service'); // eslint-disable-line global-require
    return await comms.deliverEmail({ to: to.email, subject: msg.subject, html, text: msg.body, attachments, leadId: to.leadId || null, studentId: to.studentId || null, templateKey: key, automated: true });
  } catch (e) {
    console.error(`[notify] ${key}:`, e.message); // eslint-disable-line no-console
    return { sent: false, reason: 'error' };
  }
}

module.exports = { sendTemplate, CATEGORY };
