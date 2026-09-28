// E-mail verification (only when the server can send e-mail). Unverified accounts keep working; the banner reminds them.
const knex = require('../../db/knex');
const config = require('../../config');
const brand = require('../../config/brand');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const { translator } = require('../../core/i18n');
const { randomToken, sha256 } = require('../../core/tokens');
const { AppError } = require('../../core/errors');

const HOURS = 48;
const required = () => mailer.configured();
const isVerified = (user) => Boolean(user && user.email_verified_at);

async function send(user, { locale } = {}) {
  if (!user || isVerified(user) || !required()) return false;
  const [{ n }] = await knex('email_verifications').where({ user_id: user.id }).where('created_at', '>=', new Date(Date.now() - 3600_000)).count({ n: '*' });
  if (Number(n) >= 3) throw new AppError('TOO_MANY_ATTEMPTS', 'We already sent several links. Check your inbox (and spam) or try again in an hour.', 429);
  const token = randomToken(32);
  await knex('email_verifications').insert({ user_id: user.id, email: user.email, token_hash: sha256(token), expires_at: new Date(Date.now() + HOURS * 3600_000) });
  const t = translator(user.locale || locale || 'en');
  await mailer.send({
    to: user.email, subject: `${brand.name} — ${t('verify.mail_subject')}`,
    html: mailer.layout({ locale: user.locale, title: t('verify.mail_subject'), body: t('verify.mail_body', { name: user.name, hours: HOURS }), cta: t('verify.mail_cta'), href: `${config.appUrl.replace(/\/+$/, '')}/verify-email/${token}` }),
  }).catch((e) => console.error('[mail] verification failed:', e.message)); // eslint-disable-line no-console
  return true;
}

async function confirm(token) {
  const row = await knex('email_verifications').where({ token_hash: sha256(String(token || '')) }).whereNull('used_at').where('expires_at', '>', new Date()).first();
  const user = row && await knex('users').where({ id: row.user_id }).first();
  if (!user || user.email.toLowerCase() !== row.email.toLowerCase()) throw new AppError('VERIFY_INVALID', 'This link has expired or was already used.', 404);
  await knex('email_verifications').where({ user_id: user.id }).whereNull('used_at').update({ used_at: new Date() });
  await knex('users').where({ id: user.id }).update({ email_verified_at: new Date() });
  await audit.record({ userId: user.id }, 'auth.email_verified', { entityType: 'user', entityId: user.id });
  return user;
}

module.exports = { required, isVerified, send, confirm };
