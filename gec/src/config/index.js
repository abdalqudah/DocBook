// Environment configuration. Everything that differs between installations comes from .env (see .env.example).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const env = process.env.NODE_ENV || 'development';
const isTest = env === 'test';
const isProd = env === 'production';
const root = path.join(__dirname, '..', '..');

/** SESSION_SECRET, or a generated one kept in a private file (never a public default outside dev/test). */
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isTest || env === 'development') return 'gec-dev-only-secret-gec-dev-only-secret-00';
  const file = path.join(root, '.session-secret');
  try { const v = fs.readFileSync(file, 'utf8').trim(); if (v.length >= 32) return v; } catch { /* first start */ }
  const v = crypto.randomBytes(48).toString('base64url');
  try { fs.writeFileSync(file, v, { mode: 0o600 }); } catch { /* read-only disk */ }
  console.warn('[config] SESSION_SECRET is not set: a random one was written to .session-secret'); // eslint-disable-line no-console
  return v;
}

const trustProxy = (() => {
  const v = process.env.TRUST_PROXY;
  if (v === undefined || v === '' || v === 'true') return 'loopback, linklocal, uniquelocal';
  if (v === 'false') return false;
  return /^\d+$/.test(v) ? Number(v) : v;
})();

module.exports = {
  env,
  isTest,
  isProd,
  root,
  port: Number(process.env.PORT || 3000),
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  sessionSecret: sessionSecret(),
  trustProxy,
  autoMigrate: process.env.AUTO_MIGRATE !== 'false',
  runJobs: process.env.RUN_JOBS !== 'false', // with several app instances, let exactly one run the background jobs
  locales: ['en', 'ar'],
  defaultLocale: ['en', 'ar'].includes(process.env.DEFAULT_LOCALE) ? process.env.DEFAULT_LOCALE : 'en',
  storageDir: process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : path.join(root, 'storage'),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    database: isTest ? (process.env.DB_NAME_TEST || 'gec_test') : (process.env.DB_NAME || 'gec'),
    user: process.env.DB_USER || 'gec',
    password: process.env.DB_PASSWORD || '',
    ...(process.env.DB_SOCKET ? { socketPath: process.env.DB_SOCKET } : {}),
  },
  dbPoolMax: Number(process.env.DB_POOL_MAX || 10),
  bootstrapAdmin: {
    email: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Administrator',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 465),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || '',
  },
  security: {
    bcryptRounds: isTest ? 4 : 12,
    maxFailedLogins: 5, // per account, then locked for lockMinutes
    lockMinutes: 15,
    sessionDays: 14,
  },
};
