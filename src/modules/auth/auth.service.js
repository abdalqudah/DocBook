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
  if (String(newPassword) === String(currentPassword)) throw E.validation({ new_password: 'Choose a password different from the current one.' });
  await knex('users').where({ id: user.id }).update({ password_hash: await hashPassword(newPassword), password_changed_at: new Date(), must_change_password: false });
  await require('./security.service').endOtherSessions(user.id, ctx.sessionId); // eslint-disable-line global-require
  await audit.record(ctx, 'auth.password_changed', { entityType: 'user', entityId: user.id });
}

/**
 * First sign-in with a temporary password set by a clinic admin: the person chooses their own password.
 * The temporary one may not be reused.
 */
async function replaceTemporaryPassword(ctx, { password, confirm }) {
  const user = await knex('users').where({ id: ctx.userId }).first();
  if (!user) throw E.unauthenticated();
  if (String(password || '').length < 8) throw E.validation({ password: 'Password must be at least 8 characters.' });
  if (password !== confirm) throw E.validation({ password_confirm: 'Passwords do not match.' });
  if (await bcrypt.compare(String(password), user.password_hash).catch(() => false)) throw E.validation({ password: 'Choose a password different from the current one.' });
  await knex('users').where({ id: user.id }).update({ password_hash: await hashPassword(password), password_changed_at: new Date(), must_change_password: false });
  await require('./security.service').endOtherSessions(user.id, ctx.sessionId); // eslint-disable-line global-require
  await audit.record(ctx, 'auth.temporary_password_replaced', { entityType: 'user', entityId: user.id });
}

/**
 * Platform super admin from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD / SUPER_ADMIN_NAME (called at boot, after migrations).
 * Creates the account when missing, or flags an existing account. An existing password is never overwritten.
 */
async function ensureSuperAdmin() {
  const { email, password, name } = config.superAdmin || {};
  if (!email) return null;
  const existing = await knex('users').where({ email }).first('id', 'is_platform_admin');
  if (existing) {
    if (!existing.is_platform_admin) {
      await knex('users').where({ id: existing.id }).update({ is_platform_admin: true });
      await audit.record({ userId: existing.id }, 'platform.admin_granted', { entityType: 'user', entityId: existing.id, newValues: { email } });
    }
    return existing.id;
  }
  if (String(password || '').length < 8) {
    console.warn('[auth] SUPER_ADMIN_EMAIL is set but SUPER_ADMIN_PASSWORD is missing or shorter than 8 characters; platform admin not created.'); // eslint-disable-line no-console
    return null;
  }
  const [id] = await knex('users').insert({
    name: name || 'Platform admin', email, password_hash: await hashPassword(password), locale: config.defaultLocale, is_platform_admin: true, email_verified_at: new Date(),
  });
  await audit.record({ userId: id }, 'platform.admin_created', { entityType: 'user', entityId: id, newValues: { email } });
  return id;
}

const findUser = (id) => knex('users').where({ id }).first();

module.exports = { hashPassword, createUser, authenticate, changePassword, replaceTemporaryPassword, ensureSuperAdmin, findUser, verifyPassword };
