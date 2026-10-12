const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const env = process.env.NODE_ENV || 'development';
const isTest = env === 'test';

/**
 * The session secret. Without SESSION_SECRET, only an explicit development or test run may use the built-in
 * one; any other install (NODE_ENV forgotten on a server included) gets a random secret kept in a private file
 * next to the app, so it is never the public default and survives restarts.
 */
function sessionSecretOf() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isTest || process.env.NODE_ENV === 'development') return 'dev-only-secret-dev-only-secret-dev-only';
  const fs = require('fs'); // eslint-disable-line global-require
  const file = path.join(__dirname, '..', '..', '.session-secret');
  try { const v = fs.readFileSync(file, 'utf8').trim(); if (v.length >= 32) return v; } catch { /* first start */ }
  const v = require('crypto').randomBytes(48).toString('base64url'); // eslint-disable-line global-require
  try { fs.writeFileSync(file, v, { mode: 0o600 }); } catch { /* read-only disk: this process only */ }
  console.warn('[config] SESSION_SECRET is not set: a random one was generated in .session-secret. Set SESSION_SECRET in .env.'); // eslint-disable-line no-console
  return v;
}

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * What a production server must not run without. With STRICT_CONFIG=true (set by the Docker deployment, deploy/)
 * the app refuses to start when any is missing — instead of falling back to development defaults; without it the
 * problems are only logged (shared hosts that rely on the generated .session-secret keep working).
 */
function productionProblems(e = process.env) {
  const out = [];
  const secret = String(e.SESSION_SECRET || '');
  if (secret.length < 32 || /dev-only/.test(secret)) out.push('SESSION_SECRET must be a random string of at least 32 characters.');
  if (String(e.APP_KEY || '').length < 32) out.push('APP_KEY must be set (at least 32 characters) and never changed: it encrypts stored credentials.');
  let url = null; try { url = new URL(String(e.APP_URL || '')); } catch { /* reported below */ }
  if (!url) out.push('APP_URL must be the public address, e.g. https://medworks.app');
  else if (url.protocol !== 'https:') out.push('APP_URL must start with https:// in production.');
  else if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url.hostname)) out.push('APP_URL must not be a local address in production.');
  if (!e.DB_NAME || !e.DB_USER) out.push('DB_NAME and DB_USER must be set.');
  if (!e.DB_PASSWORD) out.push('DB_PASSWORD must be set.');
  if (String(e.TRUST_PROXY || '').trim() === 'false') out.push('TRUST_PROXY must not be false behind the reverse proxy (client addresses and secure cookies depend on it).');
  if (e.SUPER_ADMIN_EMAIL && e.SUPER_ADMIN_PASSWORD && String(e.SUPER_ADMIN_PASSWORD).length < 12) out.push('SUPER_ADMIN_PASSWORD must be at least 12 characters.');
  return out;
}
const strictConfig = String(process.env.STRICT_CONFIG || '').toLowerCase() === 'true';

module.exports = {
  productionProblems,
  strictConfig,
  env,
  isProd: env === 'production',
  isTest,
  port: Number(process.env.PORT || 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  sessionSecret: sessionSecretOf(),
  // Whose X-Forwarded-For to believe: by default only a proxy on this machine or the local network (cPanel's
  // Apache / Passenger, nginx) — a client cannot fake its address to slip past the rate limits. TRUST_PROXY=false
  // turns it off; a number (hops) or a list of addresses / subnets can be given.
  trustProxy: (() => { const v = String(process.env.TRUST_PROXY || '').trim(); if (v === 'false' || v === '0') return false; if (!v || v === 'true') return 'loopback, linklocal, uniquelocal'; return /^\d+$/.test(v) ? Number(v) : v; })(),
  // Migrations run at start-up unless AUTO_MIGRATE=false (shared hosts often have no terminal for `node app.js migrate`).
  autoMigrate: process.env.AUTO_MIGRATE !== 'false' || isTest,
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: required('DB_USER', isTest ? 'docbook' : undefined),
    password: process.env.DB_PASSWORD ?? (isTest ? 'docbook' : ''),
    database: required(isTest ? 'DB_NAME_TEST' : 'DB_NAME', isTest ? 'docbook_test' : undefined),
  },
  bcryptRounds: isTest ? 4 : 12,
  cacheTtlMs: Number(process.env.CACHE_TTL_MS || 60_000),
  defaultLocale: process.env.DEFAULT_LOCALE === 'en' ? 'en' : 'ar',
  locales: ['en', 'ar'],
  // Self-service sign-up. Set ALLOW_SIGNUP=false for an invite-only installation.
  allowSignup: process.env.ALLOW_SIGNUP !== 'false' && !require('./edition').single, // eslint-disable-line global-require -- one clinic / centre: no public sign-up
  superAdmin: { email: (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim(), password: process.env.SUPER_ADMIN_PASSWORD || '', name: process.env.SUPER_ADMIN_NAME || 'Platform admin' },
};
