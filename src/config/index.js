const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const env = process.env.NODE_ENV || 'development';
const isTest = env === 'test';

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
  sessionSecret: required('SESSION_SECRET', isTest || env === 'development' ? 'dev-only-secret-dev-only-secret-dev-only' : undefined),
  trustProxy: process.env.TRUST_PROXY !== 'false',
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
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  superAdmin: { email: (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim(), password: process.env.SUPER_ADMIN_PASSWORD || '', name: process.env.SUPER_ADMIN_NAME || 'Platform admin' },
};
