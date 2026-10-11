// Subscription invoices by e-mail without anyone pressing "send": the invoice (with its link) when a clinic picks a
// plan or the platform issues one, a receipt when the payment is confirmed, and one reminder when an open invoice is
// 3 days past the start of its period. Each send is kept with the invoice (Admin → Invoices) and on the CRM contact.
// Nothing is sent while the platform's e-mail is not set up; a failure never breaks what triggered it.
const knex = require('../../db/knex');
const config = require('../../config');
const mailer = require('../../core/mailer');
const sales = require('./sales.service');

const OVERDUE_DAYS = 3;
const base = () => String(config.appUrl || '').replace(/\/+$/, '');
const sys = { userId: null };

async function send(invoiceId, kind) {
  if (!mailer.configured()) return false;
  const doc = await sales.sendable('invoice', invoiceId, base());
  if (!doc.email) return false;
  const tx = kind === 'issued' ? { subject: doc.texts.subject, body: doc.texts.body } : doc.texts[kind];
  await sales.sendEmail(sys, 'invoice', invoiceId, { to: doc.email, subject: tx.subject, body: tx.body, locale: doc.locale }, base());
  return true;
}
/** Fire and forget: the caller (a clinic choosing a plan, an admin recording a payment) is never held up. */
const later = (invoiceId, kind) => { setImmediate(() => { send(invoiceId, kind).catch((e) => console.error('[billing-mail]', kind, e.message)); }); }; // eslint-disable-line no-console
const issued = (invoiceId) => later(invoiceId, 'issued');
const paid = (invoiceId) => later(invoiceId, 'receipt');

/** Hourly: one reminder per open invoice that is OVERDUE_DAYS past its period start. */
async function runOverdue(now = new Date()) {
  if (!mailer.configured()) return { sent: 0 };
  const cutoff = new Date(now.getTime() - OVERDUE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await knex('platform_invoices').where({ status: 'open' }).whereNull('overdue_reminded_at').where('period_start', '<=', cutoff).limit(200).select('id');
  let sent = 0;
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    await knex('platform_invoices').where({ id: r.id }).update({ overdue_reminded_at: now }); // eslint-disable-line no-await-in-loop -- once, even if the send fails
    if (await send(r.id, 'overdue').catch(() => false)) sent += 1; // eslint-disable-line no-await-in-loop
  }
  return { sent };
}

module.exports = { send, issued, paid, runOverdue, OVERDUE_DAYS };
