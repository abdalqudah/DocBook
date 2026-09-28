// Password resets and session management.
const knex = require('../../db/knex');
const config = require('../../config');
const brand = require('../../config/brand');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const { translator } = require('../../core/i18n');
const { randomToken, sha256 } = require('../../core/tokens');
const { AppError, E } = require('../../core/errors');

const RESET_MINUTES = 60;

/** Creates a reset link. Returns the link when e-mail is not configured (shown to a signed-in admin only). */
async function requestReset(email, { ip, locale } = {}) {
  const user = await knex('users').where({ email: String(email || '').toLowerCase().trim(), status: 'active' }).first();
  if (!user) return null; // never reveal whether an address exists
  const [{ n }] = await knex('password_resets').where({ user_id: user.id }).where('created_at', '>=', new Date(Date.now() - 3600_000)).count({ n: '*' });
  if (Number(n) >= 5) return null;
  const token = randomToken(32);
  await knex('password_resets').insert({ user_id: user.id, token_hash: sha256(token), expires_at: new Date(Date.now() + RESET_MINUTES * 60_000) });
  const link = `${config.appUrl.replace(/\/+$/, '')}/reset/${token}`;
  const t = translator(user.locale || locale || 'en');
  await mailer.send({
    to: user.email,
    subject: `${brand.name} — ${t('auth.reset_mail_subject')}`,
    html: mailer.layout({ locale: user.locale, title: t('auth.reset_mail_subject'), body: t('auth.reset_mail_body', { minutes: RESET_MINUTES }), cta: t('auth.reset_mail_cta'), href: link }),
  }).catch((e) => console.error('[mail] reset failed:', e.message)); // eslint-disable-line no-console
  await audit.record({ userId: user.id, ip }, 'auth.reset_requested', { entityType: 'user', entityId: user.id });
  return link;
}

async function findReset(token) {
  if (!token) return null;
  return knex('password_resets').where({ token_hash: sha256(String(token)) }).whereNull('used_at').where('expires_at', '>', new Date()).first();
}

async function resetPassword(token, password, confirm, { ip } = {}) {
  const row = await findReset(token);
  if (!row) throw new AppError('RESET_INVALID', 'This link has expired or was already used.', 404);
  if (String(password || '').length < 8) throw E.validation({ password: 'Password must be at least 8 characters.' });
  if (password !== confirm) throw E.validation({ password_confirm: 'Passwords do not match.' });
  const { hashPassword } = require('./auth.service'); // eslint-disable-line global-require
  await knex.transaction(async (trx) => {
    await trx('users').where({ id: row.user_id }).update({ password_hash: await hashPassword(password), password_changed_at: new Date(), email_verified_at: trx.raw('COALESCE(email_verified_at, NOW())') });
    await trx('password_resets').where({ user_id: row.user_id }).whereNull('used_at').update({ used_at: new Date() });
  });
  await endOtherSessions(row.user_id, null);
  await audit.record({ userId: row.user_id, ip }, 'auth.password_reset', { entityType: 'user', entityId: row.user_id });
}

// Sessions live in the `sessions` table (connect-session-knex). The session JSON holds userId.
async function listSessions(userId) {
  const rows = await knex('sessions').where('expired', '>', new Date()).select('sid', 'sess', 'expired');
  return rows.map((r) => { let s = {}; try { s = typeof r.sess === 'string' ? JSON.parse(r.sess) : r.sess; } catch { s = {}; } return { sid: r.sid, s, expired: r.expired }; })
    .filter((r) => r.s.userId === userId)
    .map((r) => ({ sid: r.sid, userAgent: r.s.ua || '', ip: r.s.ip || '', since: r.s.since || null, expires: r.expired }));
}

async function endOtherSessions(userId, keepSid) {
  const mine = await listSessions(userId);
  const ids = mine.map((s) => s.sid).filter((sid) => sid !== keepSid);
  if (ids.length) await knex('sessions').whereIn('sid', ids).del();
  return ids.length;
}

async function endSession(userId, sid) {
  const mine = await listSessions(userId);
  if (!mine.some((s) => s.sid === sid)) throw E.notFound('Session');
  await knex('sessions').where({ sid }).del();
}

module.exports = { requestReset, findReset, resetPassword, listSessions, endOtherSessions, endSession, RESET_MINUTES };
