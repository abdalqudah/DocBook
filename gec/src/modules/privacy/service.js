// Privacy (GDPR-style): requests from people about their data, a complete export, and anonymisation. Anonymising
// removes the person's identity everywhere (profile, files, messages, notes, website history, portal account) but
// keeps the business facts that the law requires GEC to keep — invoices and payments — and anonymous statistics.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const people = require('../crm/people');
const uploads = require('../../core/uploads');
const settings = require('../settings/settings.service');
const jobs = require('../jobs');

const TYPES = ['export', 'delete', 'correct', 'other'];

async function createRequest(ctx, { type, email, name, details, studentId = null, leadId = null, userId = null, verified = false }) {
  const [id] = await knex('privacy_requests').insert({ ref: await people.newRef('privacy_requests', 'P'), type: TYPES.includes(type) ? type : 'other', email: email ? String(email).toLowerCase().slice(0, 190) : null, name: name ? String(name).slice(0, 160) : null, details: details ? String(details).slice(0, 4000) : null, student_id: studentId, lead_id: leadId, user_id: userId, identity_verified: !!verified });
  await audit.record(ctx, 'privacy.requested', { entityType: 'privacy_request', entityId: id, newValues: { type, verified } });
  // Tell the people who handle privacy (in-app).
  const notify = require('../notifications/service'); // eslint-disable-line global-require
  const handlers = await knex('users as u').join('employees as e', 'e.user_id', 'u.id').join('role_permissions as rp', 'rp.role_id', 'e.role_id').where('rp.permission', 'privacy.manage').where('u.status', 'active').distinct('u.id');
  for (const h of handlers) await notify.toUser(h.id, { category: 'privacy', title: { key: 'privacy.notify_new', vars: { type } }, href: `/staff/privacy/${id}` }); // eslint-disable-line no-await-in-loop
  return id;
}

/** Everything held about a student (and their leads), internal staff notes excluded. */
async function exportStudent(studentId) {
  const s = await knex('students').where({ id: studentId }).first();
  if (!s) return null;
  const strip = (row) => { const r = { ...row }; ['passport_enc', 'passport_hash', 'merged_into_id'].forEach((k) => delete r[k]); return r; };
  const leadIds = await knex('leads').where({ student_id: studentId }).pluck('id');
  return {
    exported_at: new Date().toISOString(), student: strip(s),
    leads: await knex('leads').whereIn('id', leadIds).select('ref', 'source', 'utm_source', 'utm_campaign', 'interest_degree', 'interest_field', 'created_at'),
    applications: await knex('applications').where({ student_id: studentId }).select('ref', 'program_name', 'university_name', 'intake', 'status', 'created_at', 'updated_at'),
    documents: await knex('documents as d').join('document_types as t', 't.key', 'd.type_key').where('d.student_id', studentId).select('t.name_en as type', 'd.status', 'd.uploaded_at', 'd.expiry_date', 'd.rejection_reason'),
    appointments: await knex('appointments').where((w) => w.where({ student_id: studentId }).orWhereIn('lead_id', leadIds)).select('ref', 'start_at', 'status', 'mode'),
    messages: await knex('messages').where((w) => w.where({ student_id: studentId }).orWhereIn('lead_id', leadIds)).select('channel', 'direction', 'subject', 'body', 'created_at'),
    shortlist: await knex('shortlist_items').where({ student_id: studentId }).select('item_type', 'item_id', 'created_at'),
    invoices: await knex('invoices').where({ student_id: studentId }).select('number', 'total', 'currency', 'status', 'issue_date'),
    payments: await knex('payments').where({ student_id: studentId }).select('receipt_no', 'amount', 'currency', 'method', 'received_on', 'status'),
    website_visits: leadIds.length ? await knex('tracking_events as e').join('visitors as v', 'v.id', 'e.visitor_id').whereIn('v.lead_id', leadIds).select('e.name', 'e.path', 'e.created_at').limit(2000) : [],
    consents: { contact: !!s.consent_contact, marketing: !!s.consent_marketing, marketing_since: s.consent_marketing_at, unsubscribed_at: s.unsubscribed_at },
  };
}

const PERSON_FIELDS = { last_name: null, email: null, phone: null, phone_tail: null, whatsapp: null, city: null, landing_page: null, referrer: null, visitor_id: null, consent_marketing: false, consent_contact: false };

async function anonymizeLead(trx, leadId) {
  await trx('leads').where({ id: leadId }).update({ ...PERSON_FIELDS, first_name: 'Deleted', message: null, interest_ref: null, anonymized_at: new Date(), updated_at: new Date() });
  await trx('visitors').where({ lead_id: leadId }).del(); // cascades to their tracking events
}

/** Removes a student's identity (and their leads'). Invoices / payments stay (legal retention) with the payer name removed. */
async function anonymizeStudent(ctx, studentId) {
  const s = await knex('students').where({ id: studentId }).first();
  if (!s || s.anonymized_at) return false;
  const leadIds = await knex('leads').where({ student_id: studentId }).pluck('id');
  const media = await knex('documents').where({ student_id: studentId }).whereNotNull('media_id').pluck('media_id');
  await knex.transaction(async (trx) => {
    await trx('students').where({ id: studentId }).update({ ...PERSON_FIELDS, first_name: 'Deleted', date_of_birth: null, gender: null, passport_enc: null, passport_hash: null, passport_last4: null, passport_expiry: null, institution: null, visa_history: null, profile_notes: null, status: 'closed', anonymized_at: new Date(), updated_at: new Date() });
    for (const id of leadIds) await anonymizeLead(trx, id); // eslint-disable-line no-await-in-loop
    const who = (q) => q.where((w) => { w.where('student_id', studentId); if (leadIds.length) w.orWhereIn('lead_id', leadIds); });
    await who(trx('messages')).update({ subject: null, body: null, to_address: null, from_address: null });
    await who(trx('activities')).update({ body: null });
    await who(trx('notes')).del();
    await trx('documents').where({ student_id: studentId }).del();
    await trx('shortlist_items').where({ student_id: studentId }).del();
    await trx('cost_estimates').where({ student_id: studentId }).del();
    await who(trx('appointments')).update({ contact_name: null, contact_email: null, contact_phone: null, notes: null, meeting_url: null });
    await who(trx('event_registrations')).update({ name: 'Deleted', email: null, phone: null });
    await who(trx('course_registrations')).update({ name: 'Deleted', email: null, phone: null });
    await trx('invoices').where({ student_id: studentId }).update({ bill_to_name: 'Deleted', bill_to_email: null, bill_to_phone: null, bill_to_address: null });
    if (s.user_id) {
      await trx('users').where({ id: s.user_id }).update({ status: 'disabled', email: `deleted+${s.user_id}@invalid.local`, name: 'Deleted', password_hash: null, phone: null, notification_prefs: null });
      await trx('advisor_logs').where({ user_id: s.user_id }).update({ user_id: null });
    }
  });
  if (s.user_id) await require('../auth/auth.service').endSessionsOf(s.user_id); // eslint-disable-line global-require
  for (const m of media) await uploads.remove(m); // eslint-disable-line no-await-in-loop
  await audit.record(ctx, 'privacy.anonymized', { entityType: 'student', entityId: studentId, newValues: { leads: leadIds.length, files: media.length } });
  return true;
}

async function anonymizeLeadOnly(ctx, leadId) {
  const l = await knex('leads').where({ id: leadId }).first();
  if (!l || l.anonymized_at) return false;
  if (l.student_id) return anonymizeStudent(ctx, l.student_id);
  await knex.transaction(async (trx) => {
    await anonymizeLead(trx, leadId);
    await trx('messages').where({ lead_id: leadId }).update({ subject: null, body: null, to_address: null, from_address: null });
    await trx('activities').where({ lead_id: leadId }).update({ body: null });
    await trx('notes').where({ lead_id: leadId }).del();
    await trx('appointments').where({ lead_id: leadId }).update({ contact_name: null, contact_email: null, contact_phone: null, notes: null });
  });
  await audit.record(ctx, 'privacy.anonymized', { entityType: 'lead', entityId: leadId });
  return true;
}

/** Retention: website history older than the retention period is deleted (anonymous counts stay in reports). */
async function applyRetention() {
  const months = Number(((await settings.get('privacy')) || {}).retention_months) || 36;
  const cutoff = new Date(Date.now() - months * 30 * 86400_000);
  const ev = await knex('tracking_events').where('created_at', '<', cutoff).del();
  const vis = await knex('visitors').whereNull('lead_id').where('last_seen_at', '<', cutoff).del();
  return { events: ev, visitors: vis, cutoff };
}
jobs.register('privacy.retention', 24 * 3600_000, applyRetention);

/** Leads with no activity for longer than the retention period (candidates for anonymisation). */
async function staleLeads() {
  const months = Number(((await settings.get('privacy')) || {}).retention_months) || 36;
  const cutoff = new Date(Date.now() - months * 30 * 86400_000);
  return knex('leads').whereNull('student_id').whereNull('anonymized_at').whereIn('status', ['open', 'lost']).whereRaw('COALESCE(last_activity_at, created_at) < ?', [cutoff]).select('id', 'ref', 'first_name', 'last_name', 'status', 'last_activity_at', 'created_at').limit(500);
}

module.exports = { TYPES, createRequest, exportStudent, anonymizeStudent, anonymizeLeadOnly, applyRetention, staleLeads };
