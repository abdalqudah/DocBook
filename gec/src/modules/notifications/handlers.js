// Who hears about what. Students: documents requested / rejected, application milestones, offers, visa updates,
// appointments, invoices and payments, new portal messages. Staff: tasks assigned, @mentions, leads assigned,
// replies from students and leads, documents uploaded by students, website bookings.
const knex = require('../../db/knex');
const events = require('../../core/events');
const { translator } = require('../../core/i18n');
const fmt = require('../../core/format');
const n = require('./service');

const VISIBLE_STAGES = ['application_ready', 'submitted', 'university_review', 'conditional_offer', 'unconditional_offer', 'deposit_pending', 'deposit_paid', 'cas_issued', 'visa_preparation', 'visa_submitted', 'visa_approved', 'visa_refused', 'pre_departure', 'enrolled'];
const appName = (a) => [a.program_name, a.university_name].filter(Boolean).join(' — ') || a.ref;
const localeOf = async (studentId) => ((await knex('students').where({ id: studentId }).first('preferred_locale')) || {}).preferred_locale === 'ar' ? 'ar' : 'en';

// ---- Students
events.on('document.requested', async ({ studentId, typeName, dueDate }) => {
  const locale = await localeOf(studentId);
  const t = translator(locale);
  const name = typeName ? (locale === 'ar' ? typeName.ar || typeName.en : typeName.en) : '';
  await n.toStudent(studentId, { category: 'documents', title: { key: 'notify.document_requested', vars: { name: typeName ? typeName.en : '' } }, href: '/portal/documents', template: 'missing_documents',
    vars: { document_name: name, due_text: dueDate ? ` ${t('notify.by_date', { date: fmt.formatDate(dueDate, locale) })}` : '' } });
});
events.on('document.reviewed', async ({ studentId, status, reason, typeName }) => {
  const locale = await localeOf(studentId);
  const name = typeName ? (locale === 'ar' ? typeName.ar || typeName.en : typeName.en) : '';
  if (status === 'rejected') await n.toStudent(studentId, { category: 'documents', title: { key: 'notify.document_rejected', vars: { name: typeName ? typeName.en : '' } }, href: '/portal/documents', template: 'document_rejected', vars: { document_name: name, reason: reason || '' } });
  else if (status === 'approved') await n.toStudent(studentId, { category: 'documents', title: { key: 'notify.document_approved', vars: { name: typeName ? typeName.en : '' } }, href: '/portal/documents' });
});
events.on('application.stage_changed', async ({ application: a, to }) => {
  if (!to || !VISIBLE_STAGES.includes(to.key) || ['conditional_offer', 'unconditional_offer'].includes(to.key)) return;
  const locale = await localeOf(a.student_id);
  const href = `/portal/applications/${a.id}`;
  const vars = { program_name: a.program_name || '', university_name: a.university_name || '', application_status: locale === 'ar' ? to.name_ar || to.name_en : to.name_en };
  if (to.key === 'submitted') await n.toStudent(a.student_id, { category: 'applications', title: { key: 'notify.application_submitted', vars: { name: appName(a) } }, href, template: 'application_submitted', vars });
  else await n.toStudent(a.student_id, { category: 'applications', title: { en: `${appName(a)}: ${to.name_en}`, ar: `${appName(a)}: ${to.name_ar || to.name_en}` }, href, template: ['enrolled', 'cas_issued', 'visa_approved'].includes(to.key) ? 'application_status' : null, vars });
});
events.on('application.offer_received', async ({ application: a, stage }) => {
  const locale = await localeOf(a.student_id);
  await n.toStudent(a.student_id, { category: 'applications', title: { key: 'notify.offer', vars: { name: appName(a) } }, href: `/portal/applications/${a.id}`, template: 'offer_received',
    vars: { program_name: a.program_name || '', university_name: a.university_name || '', offer_type: locale === 'ar' ? stage.name_ar || stage.name_en : stage.name_en } });
});
events.on('visa.stage_changed', async ({ visaCaseId, studentId, to }) => {
  const v = await knex('visa_cases').where({ id: visaCaseId }).first('country_code');
  const locale = await localeOf(studentId);
  const t = translator(locale);
  const country = v ? require('../catalog/reference').countryName(v.country_code, locale) : ''; // eslint-disable-line global-require
  await n.toStudent(studentId, { category: 'visa', title: { key: 'notify.visa', vars: { status: translator('en')(`visa.stage_${to}`) } }, href: '/portal', template: 'visa_update', vars: { visa_status: t(`visa.stage_${to}`), visa_country: country } });
});
events.on('appointment.booked', async ({ appointment: a, type, employee, by }) => {
  if (a.student_id) await n.toStudent(a.student_id, { category: 'appointments', title: { key: 'notify.appointment_booked', vars: { type: type.name_en, date: fmt.formatDateTime(a.start_at, 'en') } }, href: '/portal/appointments' });
  if (a.booked_via !== 'staff' && employee) await n.toEmployee(employee.id, { category: 'appointments', title: { key: 'notify.staff_booking', vars: { name: a.contact_name || '', date: fmt.formatDateTime(a.start_at, 'en') } }, href: `/staff/appointments/${a.id}` });
});
events.on('appointment.cancelled', async ({ appointment: a }) => {
  if (a.student_id) await n.toStudent(a.student_id, { category: 'appointments', title: { key: 'notify.appointment_cancelled', vars: { date: fmt.formatDateTime(a.start_at, 'en') } }, href: '/portal/appointments' });
  if (a.employee_id) await n.toEmployee(a.employee_id, { category: 'appointments', title: { key: 'notify.appointment_cancelled', vars: { date: fmt.formatDateTime(a.start_at, 'en') } }, href: `/staff/appointments/${a.id}` });
});
events.on('invoice.issued', async ({ invoiceId }) => {
  const i = await knex('invoices').where({ id: invoiceId }).first();
  if (i && i.student_id) await n.toStudent(i.student_id, { category: 'payments', title: { key: 'notify.invoice', vars: { number: i.number, amount: fmt.formatMoney(i.total, i.currency, 'en') } }, href: '/portal/payments' });
});
events.on('payment.received', async ({ paymentId }) => {
  const p = await knex('payments').where({ id: paymentId }).first();
  if (p && p.student_id) await n.toStudent(p.student_id, { category: 'payments', title: { key: 'notify.payment', vars: { amount: fmt.formatMoney(p.amount, p.currency, 'en') } }, href: '/portal/payments' });
});
events.on('message.sent', async ({ id, channel, studentId }) => {
  if (channel !== 'portal' || !studentId) return;
  const m = await knex('messages as m').leftJoin('users as u', 'u.id', 'm.sent_by').where('m.id', id).first('m.body', 'u.name');
  await n.toStudent(studentId, { category: 'messages', title: { key: 'notify.message', vars: { name: (m && m.name) || 'GEC' } }, href: '/portal/messages', template: 'new_message', vars: { counsellor_name: (m && m.name) || 'GEC', message: String((m && m.body) || '').slice(0, 1000) } });
});

// ---- Staff
events.on('task.created', async ({ task, by }) => {
  if (task.assignee_id) await n.toEmployee(task.assignee_id, { category: 'tasks', title: { key: 'notify.task', vars: { title: task.title } }, href: '/staff/tasks' }, { exceptUserId: by });
});
events.on('note.mentioned', async ({ employeeIds, leadId, studentId, by }) => {
  const author = by ? await knex('users').where({ id: by }).first('name') : null;
  const href = studentId ? `/staff/students/${studentId}` : `/staff/leads/${leadId}`;
  for (const e of employeeIds || []) await n.toEmployee(e, { category: 'mentions', title: { key: 'notify.mention', vars: { name: author ? author.name : '' } }, href }, { exceptUserId: by }); // eslint-disable-line no-await-in-loop
});
events.on('lead.assigned', async ({ lead, employeeId, by }) => {
  await n.toEmployee(employeeId, { category: 'leads', title: { key: 'notify.lead_assigned', vars: { name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') } }, href: `/staff/leads/${lead.id}` }, { exceptUserId: by });
});
events.on('message.received', async ({ id, channel, leadId, studentId }) => {
  const p = studentId ? await knex('students').where({ id: studentId }).first('counsellor_id', 'first_name', 'last_name') : await knex('leads').where({ id: leadId }).first('counsellor_id', 'first_name', 'last_name');
  if (p && p.counsellor_id) await n.toEmployee(p.counsellor_id, { category: 'messages', title: { key: 'notify.staff_message', vars: { name: [p.first_name, p.last_name].filter(Boolean).join(' '), channel } }, href: `/staff/messages/${id}` });
});
events.on('document.uploaded', async ({ studentId, typeKey, byStudent }) => {
  if (!byStudent) return;
  const s = await knex('students').where({ id: studentId }).first('counsellor_id', 'first_name', 'last_name');
  if (s && s.counsellor_id) await n.toEmployee(s.counsellor_id, { category: 'documents', title: { key: 'notify.staff_upload', vars: { name: [s.first_name, s.last_name].filter(Boolean).join(' '), doc: typeKey } }, href: `/staff/students/${studentId}?tab=documents` });
});
