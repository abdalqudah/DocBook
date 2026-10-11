// Two-step sign-in (an authenticator app's 6-digit code) — offered to platform admins, whose account sees every
// clinic. Set up from Admin → Settings → Two-step sign-in: the secret is kept encrypted (APP_KEY), ten one-time
// recovery codes are shown once and kept only as hashes. Once on, every way of signing in (password, Google,
// invitations) stops at /login/2fa until a code is entered (src/middleware/context.js).
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const totp = require('../../core/totp');
const { E, AppError } = require('../../core/errors');

const hash = (code) => crypto.createHash('sha256').update(String(code).replace(/[\s-]/g, '').toUpperCase()).digest('hex');
const enabled = (user) => Boolean(user && user.totp_enabled_at && user.totp_secret_enc);
const parse = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };

function recoveryCodes() {
  return Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})(.{5})/, '$1-$2'));
}

/** Turns it on with the secret being set up and a first code from the app → the recovery codes (shown once). */
async function enable(ctx, user, secret, code) {
  if (!/^[A-Z2-7]{16,64}$/.test(String(secret || ''))) throw new AppError('TOTP_EXPIRED', 'Start again: the setup expired.', 409);
  const step = totp.verify(secret, code);
  if (step === null) throw E.validation({ code: 'The code is not right. Check the time on your phone and try the newest code.' });
  const codes = recoveryCodes();
  await knex('users').where({ id: user.id }).update({ totp_secret_enc: secrets.encrypt(secret), totp_enabled_at: new Date(), totp_recovery: JSON.stringify(codes.map(hash)), totp_last_step: step });
  await audit.record(ctx, 'auth.totp_enabled', { entityType: 'user', entityId: user.id });
  return codes;
}

/** Checks a sign-in code (or a recovery code, used up) → true / false. */
async function check(user, code) {
  if (!enabled(user)) return true;
  const fresh = await knex('users').where({ id: user.id }).first('totp_secret_enc', 'totp_last_step', 'totp_recovery');
  const secret = secrets.decrypt(fresh.totp_secret_enc);
  const c = String(code || '').trim();
  if (/^\d{6}$/.test(c.replace(/\s+/g, ''))) {
    const step = secret ? totp.verify(secret, c, { after: fresh.totp_last_step }) : null;
    if (step === null) return false;
    // the step is stored only if no other request stored a newer one (the same code can't pass twice)
    const n = await knex('users').where({ id: user.id }).where((q) => q.whereNull('totp_last_step').orWhere('totp_last_step', '<', step)).update({ totp_last_step: step });
    return n === 1;
  }
  const list = parse(fresh.totp_recovery);
  const h = hash(c);
  if (!c || !list.includes(h)) return false;
  await knex('users').where({ id: user.id }).update({ totp_recovery: JSON.stringify(list.filter((x) => x !== h)) });
  await audit.record({ userId: user.id }, 'auth.totp_recovery_used', { entityType: 'user', entityId: user.id, newValues: { left: list.length - 1 } });
  return true;
}

/** Turns it off (a current code or a recovery code is required). */
async function disable(ctx, user, code) {
  if (!enabled(user)) return;
  if (!(await check(user, code))) throw E.validation({ code: 'The code is not right.' });
  await knex('users').where({ id: user.id }).update({ totp_secret_enc: null, totp_enabled_at: null, totp_recovery: null, totp_last_step: null });
  await audit.record(ctx, 'auth.totp_disabled', { entityType: 'user', entityId: user.id });
}

const recoveryLeft = (user) => parse(user && user.totp_recovery).length;

module.exports = { enabled, enable, check, disable, recoveryLeft, recoveryCodes };
