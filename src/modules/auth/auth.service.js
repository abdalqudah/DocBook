const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);
const hashPassword = (plain) => bcrypt.hash(String(plain), config.bcryptRounds);

// Accounts imported from DocBook keep their scrypt hash ("salt:hash") until the first sign-in, then move to bcrypt.
const DOCBOOK_SCRYPT = /^[0-9a-f]{32}:[0-9a-f]{128}$/;
function verifyDocbookScrypt(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
  } catch { return false; }
}

async function verifyPassword(user, password) {
  if (user && DOCBOOK_SCRYPT.test(user.password_hash)) {
    const ok = verifyDocbookScrypt(password, user.password_hash);
    if (ok) await knex('users').where({ id: user.id }).update({ password_hash: await hashPassword(password) });
    return ok;
  }
  return bcrypt.compare(String(password), user ? user.password_hash : DUMMY_HASH);
}

async function createUser(trx, { name, email, password, locale }) {
  const existing = await trx('users').where({ email }).first();
  if (existing) throw E.conflict('EMAIL_TAKEN', 'An account with this email already exists.');
  const [id] = await trx('users').insert({ name, email, password_hash: await hashPassword(password), locale: locale || 'en' });
  return id;
}

async function authenticate({ email, password }, ctx = {}) {
  const user = await knex('users').where({ email: String(email).toLowerCase().trim() }).first();
  if (user) {
    const [{ n }] = await knex('audit_logs').where({ user_id: user.id, action: 'auth.login_failed' }).where('created_at', '>=', new Date(Date.now() - 15 * 60_000)).count({ n: '*' });
    if (Number(n) >= 10) throw new AppError('TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Wait 15 minutes or reset your password.', 429);
  }
  const ok = await verifyPassword(user, password);
  if (!user || !ok) {
    await audit.record({ ...ctx, userId: user?.id }, 'auth.login_failed', { entityType: 'user', entityId: user?.id, newValues: { email } });
    throw E.invalidCredentials();
  }
  if (user.status !== 'active') throw new AppError('ACCOUNT_DISABLED', 'This account is disabled.', 403);
  await knex('users').where({ id: user.id }).update({ last_login_at: new Date() });
  await audit.record({ ...ctx, userId: user.id }, 'auth.login', { entityType: 'user', entityId: user.id });
  return user;
}

async function changePassword(ctx, { currentPassword, newPassword }) {
  const user = await knex('users').where({ id: ctx.userId }).first();
  if (!(await verifyPassword(user, currentPassword))) throw E.validation({ current_password: 'Current password is incorrect.' });
  await knex('users').where({ id: user.id }).update({ password_hash: await hashPassword(newPassword), password_changed_at: new Date() });
  await require('./security.service').endOtherSessions(user.id, ctx.sessionId); // eslint-disable-line global-require
  await audit.record(ctx, 'auth.password_changed', { entityType: 'user', entityId: user.id });
}

const findUser = (id) => knex('users').where({ id }).first();

module.exports = { hashPassword, createUser, authenticate, changePassword, findUser, verifyPassword };
