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

module.exports = {
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
