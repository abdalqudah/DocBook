// Accounts: password hashing, sign-in with lockout, password reset, sessions.
const bcrypt = require('bcryptjs');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { randomToken, sha256 } = require('../../core/tokens');

const RESET_MINUTES = 60;
const hashPassword = (pw) => bcrypt.hash(String(pw), config.security.bcryptRounds);
// A real hash of a random value: comparing against it for unknown e-mails keeps the answer time the same.
const DUMMY = bcrypt.hashSync('not-a-real-password', 4);

/**
 * Checks e-mail + password for one portal. Wrong password: counts a failure and locks the account for a while
 * after `maxFailedLogins` in a row. Never says whether the e-mail exists.
 */
async function authenticate({ email, password, portal, ip }) {
  const address = String(email || '').trim().toLowerCase();
  const user = await knex('users').where({ email: address, kind: portal }).first();
  const ok = await bcrypt.compare(String(password || ''), (user && user.password_hash) || DUMMY);
  await knex('login_attempts').insert({ email: address.slice(0, 190), ip: String(ip || '').slice(0, 64), portal, success: Boolean(user && ok) });
  if (!user || !user.password_hash) throw E.invalidCredentials();
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw E.locked(Math.ceil((new Date(user.locked_until) - Date.now()) / 60000));
  }
  if (!ok) {
    const failed = user.failed_logins + 1;
    const lock = failed >= config.security.maxFailedLogins;
    await knex('users').where({ id: user.id }).update({
      failed_logins: lock ? 0 : failed,
      locked_until: lock ? new Date(Date.now() + config.security.lockMinutes * 60000) : null,
    });
    if (lock) await audit.record({ userId: user.id, ip }, 'auth.locked', { entityType: 'user', entityId: user.id });
    throw E.invalidCredentials();
  }
  if (user.status === 'disabled') throw E.disabled();
  await knex('users').where({ id: user.id }).update({ failed_logins: 0, locked_until: null, last_login_at: new Date(), status: user.status === 'invited' ? 'active' : user.status });
  await audit.record({ userId: user.id, ip }, 'auth.login', { entityType: 'user', entityId: user.id, newValues: { portal } });
  return user;
}

/** Starts a fresh session for the user (session fixation safe). */
function startSession(req, user) {
  return new Promise((resolve, reject) => {
    const returnTo = req.session.returnTo;
    const visitorId = req.session.visitorId;
    req.session.regenerate((err) => {
      if (err) return reject(err);
      Object.assign(req.session, {
        userId: user.id,
        kind: user.kind,
        returnTo,
        visitorId,
        ua: String(req.get('user-agent') || '').slice(0, 200),
        ip: req.ip,
        since: new Date().toISOString(),
        csrf: randomToken(24),
      });
      return req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

function endSession(req) {
  return new Promise((resolve) => { req.session.destroy(() => resolve()); });
}

/** Creates a reset token. Returns the link (the caller e-mails it). Silent for unknown addresses. */
async function createReset(email, portal) {
  const user = await knex('users').where({ email: String(email || '').trim().toLowerCase(), kind: portal }).whereNot({ status: 'disabled' }).first();
  if (!user) return null;
  const [{ n }] = await knex('password_resets').where({ user_id: user.id }).where('created_at', '>=', new Date(Date.now() - 3600_000)).count({ n: '*' });
  if (Number(n) >= 5) return null;
  const token = randomToken(32);
  await knex('password_resets').insert({ user_id: user.id, token_hash: sha256(token), expires_at: new Date(Date.now() + RESET_MINUTES * 60000) });
  return { user, token, link: `${config.appUrl}/${portal === 'staff' ? 'staff/' : ''}reset/${token}` };
}

async function findReset(token) {
  if (!token) return null;
  return knex('password_resets').where({ token_hash: sha256(String(token)) }).whereNull('used_at').where('expires_at', '>', new Date()).first();
}

async function resetPassword(token, password, { ip } = {}) {
  const row = await findReset(token);
  if (!row) throw new AppError('RESET_INVALID', 'This link has expired or was already used.', 404);
  await knex.transaction(async (trx) => {
    await trx('users').where({ id: row.user_id }).update({ password_hash: await hashPassword(password), password_changed_at: new Date(), must_change_password: false, failed_logins: 0, locked_until: null, email_verified_at: trx.raw('COALESCE(email_verified_at, NOW())') });
    await trx('password_resets').where({ user_id: row.user_id }).whereNull('used_at').update({ used_at: new Date() });
  });
  await endSessionsOf(row.user_id);
  await audit.record({ userId: row.user_id, ip }, 'auth.password_reset', { entityType: 'user', entityId: row.user_id });
  return row.user_id;
}

async function changePassword(ctx, userId, current, next, keepSid) {
  const user = await knex('users').where({ id: userId }).first();
  if (!user || !(await bcrypt.compare(String(current || ''), user.password_hash || DUMMY))) throw E.validation({ current_password: 'Current password is incorrect.' });
  await knex('users').where({ id: userId }).update({ password_hash: await hashPassword(next), password_changed_at: new Date(), must_change_password: false });
  await endSessionsOf(userId, keepSid);
  await audit.record(ctx, 'auth.password_changed', { entityType: 'user', entityId: userId });
}

// Sessions live in the `sessions` table (connect-session-knex); the session JSON holds userId.
async function sessionsOf(userId) {
  const rows = await knex('sessions').where('expired', '>', new Date()).whereRaw('sess LIKE ?', [`%"userId":${Number(userId)},%`]).select('sid', 'sess', 'expired');
  return rows.map((r) => { let s = {}; try { s = typeof r.sess === 'string' ? JSON.parse(r.sess) : r.sess; } catch { s = {}; } return { sid: r.sid, s, expired: r.expired }; })
    .filter((r) => r.s.userId === Number(userId))
    .map((r) => ({ sid: r.sid, userAgent: r.s.ua || '', ip: r.s.ip || '', since: r.s.since || null, expires: r.expired }));
}

async function endSessionsOf(userId, keepSid = null) {
  const ids = (await sessionsOf(userId)).map((s) => s.sid).filter((sid) => sid !== keepSid);
  if (ids.length) await knex('sessions').whereIn('sid', ids).del();
  return ids.length;
}

async function revokeSession(userId, sid) {
  if (!(await sessionsOf(userId)).some((s) => s.sid === sid)) throw E.notFound('Session');
  await knex('sessions').where({ sid }).del();
}

module.exports = { hashPassword, authenticate, startSession, endSession, createReset, findReset, resetPassword, changePassword, sessionsOf, endSessionsOf, revokeSession, RESET_MINUTES };
