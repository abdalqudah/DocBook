// Booking side-effects: confirmations and tickets by e-mail, the lead pipeline following appointments, reminders.
const knex = require('../../db/knex');
const config = require('../../config');
const events = require('../../core/events');
const fmt = require('../../core/format');
const settings = require('../settings/settings.service');
const notify = require('../comms/notify');
const leadStages = require('../crm/stages');
const activity = require('../crm/activity.service');
const scheduling = require('./scheduling');
const appointments = require('./appointments.service');
const jobs = require('../jobs');

/** Who to write to for an appointment / registration: the student, else the lead, else the contact on the booking. */
async function recipientOf({ leadId, studentId, email, name }) {
  if (studentId) { const s = await knex('students').where({ id: studentId }).first('first_name', 'email', 'preferred_locale'); if (s && s.email) return { email: s.email, name: s.first_name, locale: s.preferred_locale, studentId, leadId }; }
  if (leadId) { const l = await knex('leads').where({ id: leadId }).first('first_name', 'email', 'preferred_locale'); if (l && l.email) return { email: l.email, name: l.first_name, locale: l.preferred_locale, leadId }; }
  return email ? { email, name, locale: 'en', leadId, studentId } : null;
}

async function apptVars(appt, locale) {
  const type = await knex('appointment_types').where({ id: appt.type_id }).first();
  const emp = appt.employee_id ? await knex('employees as e').join('users as u', 'u.id', 'e.user_id').leftJoin('branches as b', 'b.id', 'e.branch_id').where('e.id', appt.employee_id).first('u.name', 'b.timezone') : null;
  const tz = (emp && emp.timezone) || (await settings.get('general')).timezone || 'UTC';
  const L = (en, ar) => (locale === 'ar' && ar ? ar : en);
  return {
    appointment_type: L(type.name_en, type.name_ar), counsellor_name: emp ? emp.name : '',
    appointment_date: `${fmt.formatDate(appt.start_at, locale, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }, tz)} (${tz})`,
    appointment_place: appt.mode === 'online' ? (appt.meeting_url ? `${L('Online meeting', 'اجتماع عبر الإنترنت')}: ${appt.meeting_url}` : L('Online — the meeting link will be sent before the appointment.', 'عبر الإنترنت — سيصلك رابط الاجتماع قبل الموعد.')) : (appt.location || type.location_text || ''),
    type,
  };
}

events.on('appointment.booked', async ({ appointment: a }) => {
  // the lead pipeline: a booked consultation moves an early lead to "Counselling Booked"
  if (a.lead_id) {
    const target = await leadStages.byKey('counselling_booked');
    const lead = await knex('leads as l').join('lead_stages as s', 's.id', 'l.stage_id').where('l.id', a.lead_id).first('l.id', 'l.status', 's.position', 'l.first_contacted_at');
    if (target && lead && lead.status === 'open' && lead.position < target.position) {
      await knex('leads').where({ id: lead.id }).update({ stage_id: target.id, stage_entered_at: new Date(), first_contacted_at: lead.first_contacted_at || new Date() });
      await activity.log({ leadId: lead.id }, { type: 'stage', title: 'stage', meta: { to: target.key, to_en: target.name_en, to_ar: target.name_ar, auto: true } });
    }
  }
  const to = await recipientOf({ leadId: a.lead_id, studentId: a.student_id, email: a.contact_email, name: a.contact_name });
  if (!to) return;
  const v = await apptVars(a, to.locale);
  const link = a.manage_token ? `${config.appUrl}/appointments/${a.manage_token}` : null;
  const ics = scheduling.ics({ uid: `${a.ref}@gec`, start: a.start_at, end: a.end_at, title: v.appointment_type, description: v.appointment_place, location: a.mode === 'online' ? (a.meeting_url || 'Online') : v.appointment_place, url: link || '' });
  await notify.sendTemplate('consultation_confirmation', to, v, { link, attachments: [{ filename: 'appointment.ics', content: ics, contentType: 'text/calendar' }] });
});

events.on('appointment.completed', async ({ appointment: a }) => {
  if (!a.lead_id) return;
  const target = await leadStages.byKey('counselling_done');
  const lead = await knex('leads as l').join('lead_stages as s', 's.id', 'l.stage_id').where('l.id', a.lead_id).first('l.id', 'l.status', 's.position');
  if (target && lead && lead.status === 'open' && lead.position < target.position) {
    await knex('leads').where({ id: lead.id }).update({ stage_id: target.id, stage_entered_at: new Date() });
    await activity.log({ leadId: lead.id }, { type: 'stage', title: 'stage', meta: { to: target.key, to_en: target.name_en, to_ar: target.name_ar, auto: true } });
  }
});

events.on('course.registered', async ({ registration: r, course }) => {
  const to = await recipientOf({ leadId: r.lead_id, studentId: r.student_id, email: r.email, name: r.name });
  if (!to) return;
  const L = (en, ar) => (to.locale === 'ar' && ar ? ar : en);
  const statusText = { pending: L('pending payment', 'بانتظار الدفع'), confirmed: L('confirmed', 'مؤكد'), waitlist: L('on the wait-list', 'على قائمة الانتظار') }[r.status] || r.status;
  await notify.sendTemplate('course_registration', to, {
    course_name: L(course.name_en, course.name_ar), course_dates: [course.start_date, course.end_date].filter(Boolean).map((d) => fmt.formatDate(d, to.locale)).join(' – ') || L(course.schedule_en, course.schedule_ar) || '',
    registration_status: statusText, payment_text: r.payment_status === 'unpaid' ? L(` Amount due: ${fmt.formatMoney(r.amount, r.currency, 'en')}. We will contact you about payment.`, ` المبلغ المستحق: ${fmt.formatMoney(r.amount, r.currency, 'ar')}. سنتواصل معك بخصوص الدفع.`) : '',
  }, { link: `${config.appUrl}/courses/registration/${r.manage_token}` });
});

async function eventVars(ev, locale) {
  const tz = (await settings.get('general')).timezone || 'UTC';
  const L = (en, ar) => (locale === 'ar' && ar ? ar : en);
  return {
    event_name: L(ev.title_en, ev.title_ar), event_date: `${fmt.formatDate(ev.starts_at, locale, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }, tz)} (${tz})`,
    event_place: ev.is_virtual ? (ev.meeting_url ? `${L('Join online', 'الانضمام عبر الإنترنت')}: ${ev.meeting_url}` : L('Online — the link is on your ticket.', 'عبر الإنترنت — الرابط في تذكرتك.')) : L(ev.location_en, ev.location_ar) || '',
  };
}

events.on('event.registered', async ({ registration: r, event: ev }) => {
  const to = await recipientOf({ leadId: r.lead_id, studentId: r.student_id, email: r.email, name: r.name });
  if (to) await notify.sendTemplate('event_registration', to, await eventVars(ev, to.locale), { link: `${config.appUrl}/tickets/${r.ticket_token}` });
});

// ---- Reminders (every 15 minutes; each message only once)
jobs.register('appointments.reminders', 15 * 60_000, async () => {
  const hours = (await settings.get('appointments')).reminder_hours || 24;
  for (const a of await appointments.dueReminders(hours)) {
    await knex('appointments').where({ id: a.id }).update({ reminder_sent_at: new Date() }); // eslint-disable-line no-await-in-loop
    const to = await recipientOf({ leadId: a.lead_id, studentId: a.student_id, email: a.contact_email, name: a.contact_name }); // eslint-disable-line no-await-in-loop
    if (!to) continue; // eslint-disable-line no-continue
    const v = await apptVars(a, to.locale); // eslint-disable-line no-await-in-loop
    await notify.sendTemplate('appointment_reminder', to, v, { link: a.manage_token ? `${config.appUrl}/appointments/${a.manage_token}` : null }); // eslint-disable-line no-await-in-loop
    await events.emit('appointment.reminder', { appointment: a }); // eslint-disable-line no-await-in-loop
  }
});

jobs.register('events.reminders', 30 * 60_000, async () => {
  const now = new Date();
  const soon = await knex('event_registrations as r').join('events as e', 'e.id', 'r.event_id').where('r.status', 'registered').whereNull('r.reminder_sent_at')
    .where('e.starts_at', '>', now).where('e.starts_at', '<=', new Date(now.getTime() + 24 * 3600_000)).select('r.*', 'e.title_en', 'e.title_ar', 'e.starts_at', 'e.is_virtual', 'e.meeting_url', 'e.location_en', 'e.location_ar');
  for (const r of soon) {
    await knex('event_registrations').where({ id: r.id }).update({ reminder_sent_at: new Date() }); // eslint-disable-line no-await-in-loop
    const to = await recipientOf({ leadId: r.lead_id, studentId: r.student_id, email: r.email, name: r.name }); // eslint-disable-line no-await-in-loop
    if (to) await notify.sendTemplate('event_reminder', to, await eventVars(r, to.locale), { link: `${config.appUrl}/tickets/${r.ticket_token}` }); // eslint-disable-line no-await-in-loop
  }
  // follow-up the day after for attendees
  const done = await knex('event_registrations as r').join('events as e', 'e.id', 'r.event_id').where('r.status', 'attended').whereNull('r.follow_up_sent_at')
    .whereRaw('COALESCE(e.ends_at, e.starts_at) < ?', [new Date(now.getTime() - 12 * 3600_000)]).select('r.*', 'e.title_en', 'e.title_ar');
  for (const r of done) {
    await knex('event_registrations').where({ id: r.id }).update({ follow_up_sent_at: new Date() }); // eslint-disable-line no-await-in-loop
    const to = await recipientOf({ leadId: r.lead_id, studentId: r.student_id, email: r.email, name: r.name }); // eslint-disable-line no-await-in-loop
    if (to) await notify.sendTemplate('event_follow_up', to, { event_name: to.locale === 'ar' && r.title_ar ? r.title_ar : r.title_en }, { link: `${config.appUrl}/book` }); // eslint-disable-line no-await-in-loop
  }
});

module.exports = { recipientOf, apptVars, eventVars };
