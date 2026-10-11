// The customer's answer to a quotation, from its link: accept (name, title and a drawn signature), decline with a
// reason, or negotiate the amount. The team answers and revises on the same link. Everything is kept on the
// quotation, written to the CRM timeline and e-mailed to the team (and a copy of the accepted quotation to the customer).
const knex = require('../../db/knex');
const { E, AppError } = require('../../core/errors');
const sales = require('./sales.service');

const DECLINE_REASONS = ['price', 'timing', 'other_provider', 'not_needed', 'other'];
const str = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const crm = () => require('../crm/crm.service'); // eslint-disable-line global-require
const sys = { userId: null };

async function openQuote(token) {
  const q = await sales.quoteByToken(token, { count: false });
  const state = sales.quoteState(q);
  if (['accepted', 'declined'].includes(state)) throw new AppError('QUOTE_ANSWERED', 'This quotation was already answered.', 409);
  if (state === 'expired') throw new AppError('QUOTE_EXPIRED', 'This quotation has expired. Please ask us for an updated one.', 409);
  if (q.status === 'draft') throw E.notFound('Quotation');
  return q;
}
const event = (q, e) => knex('quote_events').insert({ quote_id: q.id, revision: q.revision, ...e });

/** The team: whoever made the quotation, plus the seller e-mail. */
async function tellTeam(q, subjectAr, subjectEn, body, base) {
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  const p = await sales.profile();
  const to = [];
  const owner = q.created_by ? await knex('users').where({ id: q.created_by }).first('email', 'locale') : null;
  if (owner) to.push(owner);
  if (p.email && !to.some((x) => x.email.toLowerCase() === p.email.toLowerCase())) to.push({ email: p.email, locale: 'ar' });
  for (const r of to) { // eslint-disable-line no-restricted-syntax
    const ar = r.locale !== 'en';
    const title = `${q.number}: ${ar ? subjectAr : subjectEn}`;
    await mailer.send({ kind: 'quote_answer', to: r.email, subject: title, html: mailer.layout({ locale: ar ? 'ar' : 'en', title, body: `${q.customer_name}${q.customer_company ? ` · ${q.customer_company}` : ''}<br>${body || ''}`, cta: ar ? 'افتح العرض' : 'Open quotation', href: `${String(base || process.env.APP_URL || '').replace(/\/+$/, '')}/admin/quotes/${q.id}` }) }).catch(() => {}); // eslint-disable-line no-await-in-loop
  }
  require('../platformnotify/notify.service').admin('quote_answer', { number: q.number, customer: q.customer_name }, { link: `/admin/quotes/${q.id}`, severity: 'info' }).catch(() => {}); // eslint-disable-line global-require
}

/** A drawn signature: a PNG data URL from the page's canvas (at most 400 KB). */
function readSignature(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.slice(0, 8).equals(PNG) && buf.length <= 400 * 1024 ? buf : null;
}

async function accept(token, body, { ip, base } = {}) {
  const q = await openQuote(token);
  const name = str(body.name, 150);
  const signature = readSignature(body.signature);
  const errors = {};
  if (!name) errors.name = 'Enter your name.';
  if (!signature) errors.signature = 'Sign in the box.';
  if (body.agree !== '1') errors.agree = 'Please confirm you accept the quotation.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const now = new Date();
  await knex('quotes').where({ id: q.id }).update({ status: 'accepted', responded_at: now, response_name: name, signer_title: str(body.title, 120) || null, signature, response_ip: str(ip, 64) || null, updated_at: now });
  await event(q, { type: 'accepted', by: 'customer', name, amount: q.total });
  if (q.contact_id) {
    await crm().log(sys, q.contact_id, 'quote', `${q.number}: accepted by ${name}`).catch(() => {});
    await knex('crm_contacts').where({ id: q.contact_id }).whereNotIn('stage', ['customer']).update({ stage: 'customer', updated_at: now }).catch(() => {});
  }
  await tellTeam(q, `وافق ${name}`, `accepted by ${name}`, '', base);
  // a copy for the customer
  if (q.customer_email) {
    const mailer = require('../../core/mailer'); // eslint-disable-line global-require
    const ar = q.locale !== 'en';
    await mailer.send({ kind: 'quote_copy', to: q.customer_email, subject: ar ? `نسخة عرض السعر الموقّع ${q.number}` : `Your signed quotation ${q.number}`, html: mailer.layout({ locale: q.locale, title: q.number, body: ar ? 'شكراً لموافقتك. نسخة عرض السعر الموقّع على الرابط.' : 'Thank you for accepting. Your signed quotation is at the link.', cta: ar ? 'عرض السعر' : 'View quotation', href: `${String(base || process.env.APP_URL || '').replace(/\/+$/, '')}/quote/${q.token}` }) }).catch(() => {});
  }
}

async function decline(token, body, { base } = {}) {
  const q = await openQuote(token);
  const reason = DECLINE_REASONS.includes(body.reason) ? body.reason : null;
  if (!reason) throw E.validation({ reason: 'Choose a reason.' });
  const note = str(body.note, 500) || null;
  const now = new Date();
  await knex('quotes').where({ id: q.id }).update({ status: 'declined', responded_at: now, decline_reason: reason, response_note: note, response_name: str(body.name, 150) || null, updated_at: now });
  await event(q, { type: 'declined', by: 'customer', name: str(body.name, 150) || null, message: [reason, note].filter(Boolean).join(' — ') });
  if (q.contact_id) await crm().log(sys, q.contact_id, 'quote', `${q.number}: declined (${reason})${note ? ` — ${note}` : ''}`).catch(() => {});
  await tellTeam(q, 'رفض العميل', 'declined', `${reason}${note ? ` — ${note}` : ''}`, base);
}

async function negotiate(token, body, { base } = {}) {
  const q = await openQuote(token);
  const amount = body.amount === undefined || body.amount === '' ? null : Number(String(body.amount).replace(/,/g, ''));
  const message = str(body.message, 2000);
  const errors = {};
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) errors.amount = 'Enter the amount you propose.';
  if (!message && amount === null) errors.message = 'Write what you would like to change.';
  if (Object.keys(errors).length) throw E.validation(errors);
  await knex('quotes').where({ id: q.id }).update({ status: 'negotiating', updated_at: new Date() });
  await event(q, { type: 'negotiation', by: 'customer', name: str(body.name, 150) || null, amount, message: message || null });
  if (q.contact_id) await crm().log(sys, q.contact_id, 'quote', `${q.number}: negotiation${amount !== null ? ` (${amount} ${q.currency})` : ''}${message ? `\n${message}` : ''}`).catch(() => {});
  await tellTeam(q, 'طلب تفاوض', 'negotiation request', `${amount !== null ? `${amount} ${q.currency}<br>` : ''}${message}`, base);
}

/** The team's reply on the quotation's conversation (the customer sees it on the link). */
async function reply(ctx, quoteId, message) {
  const q = await sales.getQuote(quoteId);
  const text = str(message, 2000);
  if (!text) throw E.validation({ message: 'Write the reply.' });
  await event(q, { type: 'reply', by: 'team', user_id: ctx.userId || null, message: text });
}

module.exports = { DECLINE_REASONS, accept, decline, negotiate, reply, readSignature };
