// Finance notifications: payment confirmation to the payer, invoice e-mail with its private link.
const knex = require('../../db/knex');
const config = require('../../config');
const events = require('../../core/events');
const fmt = require('../../core/format');
const notify = require('../comms/notify');

events.on('payment.received', async ({ paymentId }) => {
  const p = await knex('payments as p').leftJoin('invoices as i', 'i.id', 'p.invoice_id').leftJoin('students as s', 's.id', 'p.student_id').leftJoin('leads as l', 'l.id', 'p.lead_id')
    .where('p.id', paymentId).first('p.*', 'i.number', 'i.public_token', 'i.bill_to_email', 's.email as s_email', 's.first_name as s_first', 's.preferred_locale as s_locale', 'l.email as l_email', 'l.first_name as l_first', 'l.preferred_locale as l_locale');
  if (!p) return;
  const to = p.bill_to_email || p.s_email || p.l_email;
  const locale = (p.s_locale || p.l_locale) === 'ar' ? 'ar' : 'en';
  const items = p.invoice_id ? await knex('invoice_items').where({ invoice_id: p.invoice_id }).orderBy('position').limit(3).pluck('description') : [];
  await notify.sendTemplate('payment_confirmation', { email: to, name: p.s_first || p.l_first, locale, leadId: p.lead_id, studentId: p.student_id }, {
    amount: fmt.formatMoney(p.amount, p.currency, locale), service_name: items.join(', ') || (locale === 'ar' ? 'خدمات GEC' : 'GEC services'), invoice_number: p.receipt_no,
  }, { link: p.public_token ? `${config.appUrl}/invoices/${p.public_token}` : null });
});
