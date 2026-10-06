// Newsletter: sign-up from the website with double opt-in (nobody is mailed until they click the confirmation
// link), a private manage/unsubscribe link, and the subscriber list used as a campaign audience.
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { randomToken } = require('../../core/tokens');
const email = require('../comms/email');
const { translator } = require('../../core/i18n');

const RESEND_MINUTES = 10;

/** Starts (or restarts) a subscription and sends the confirmation e-mail. Never reveals whether an address exists. */
async function subscribe(ctx, { email: addr, name = null, locale = 'en', interests = [], degree = null, source = null, utm = {}, consentText }) {
  const address = String(addr).trim().toLowerCase();
  const existing = await knex('newsletter_subscribers').where({ email: address }).first();
  if (existing && existing.status === 'confirmed') return { status: 'confirmed', id: existing.id };
  if (existing && existing.confirm_sent_at && Date.now() - new Date(existing.confirm_sent_at) < RESEND_MINUTES * 60000) return { status: 'pending', id: existing.id };
  const token = randomToken(32);
  const row = { name: name || (existing && existing.name) || null, locale: locale === 'ar' ? 'ar' : 'en', interests: JSON.stringify(interests || []), degree, status: 'pending', confirm_token: token, consent_text: String(consentText || '').slice(0, 500), consent_ip: String(ctx.ip || '').slice(0, 64), confirm_sent_at: new Date(), updated_at: new Date() };
  let id;
  if (existing) { id = existing.id; await knex('newsletter_subscribers').where({ id }).update(row); } else {
    [id] = await knex('newsletter_subscribers').insert({ ...row, email: address, source: source ? String(source).slice(0, 60) : null, utm_source: utm.utm_source || null, utm_medium: utm.utm_medium || null, utm_campaign: utm.utm_campaign || null, manage_token: randomToken(32) });
  }
  const t = translator(row.locale);
  const link = `${config.appUrl}/newsletter/confirm/${token}`;
  const html = await email.layout({ locale: row.locale, title: t('newsletter.mail_title'), body: t('newsletter.mail_body', { name: row.name || '' }), cta: t('newsletter.mail_cta'), href: link });
  await email.send({ to: address, subject: t('newsletter.mail_title'), html }).catch(() => null);
  return { status: 'pending', id };
}

async function byConfirmToken(token) { return /^[A-Za-z0-9_-]{20,64}$/.test(String(token || '')) ? knex('newsletter_subscribers').where({ confirm_token: token }).first() : null; }
async function byManageToken(token) { return /^[A-Za-z0-9_-]{20,64}$/.test(String(token || '')) ? knex('newsletter_subscribers').where({ manage_token: token }).first() : null; }

async function confirm(ctx, token) {
  const s = await byConfirmToken(token);
  if (!s) return null;
  if (s.confirm_sent_at && Date.now() - new Date(s.confirm_sent_at) > 14 * 86400_000) return null; // links expire after two weeks
  await knex('newsletter_subscribers').where({ id: s.id }).update({ status: 'confirmed', confirmed_at: new Date(), confirm_token: null, unsubscribed_at: null, updated_at: new Date() });
  await audit.record(ctx, 'newsletter.confirmed', { entityType: 'newsletter_subscriber', entityId: s.id });
  await events.emit('newsletter.confirmed', { id: s.id });
  return s;
}

async function unsubscribeSubscriber(id) {
  await knex('newsletter_subscribers').where({ id }).update({ status: 'unsubscribed', unsubscribed_at: new Date(), confirm_token: null, updated_at: new Date() });
}
/** Address-wide: used when someone unsubscribes from any campaign. */
async function unsubscribeEmail(addr) {
  if (!addr || !String(addr).includes('@')) return;
  await knex('newsletter_subscribers').where({ email: String(addr).toLowerCase() }).whereNot({ status: 'unsubscribed' }).update({ status: 'unsubscribed', unsubscribed_at: new Date(), confirm_token: null, updated_at: new Date() });
}

async function counts() {
  const rows = await knex('newsletter_subscribers').groupBy('status').select('status').count({ n: '*' });
  const out = { pending: 0, confirmed: 0, unsubscribed: 0 };
  rows.forEach((r) => { out[r.status] = Number(r.n); });
  return out;
}

module.exports = { subscribe, confirm, byConfirmToken, byManageToken, unsubscribeSubscriber, unsubscribeEmail, counts };
