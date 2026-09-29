const http = require('http');
const brand = require('./config/brand');

// Load .env first (config does it) so PORT from the .env file is honoured, not only from the process environment.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const PORT = process.env.PORT || 3000;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HINTS = {
  ER_ACCESS_DENIED_ERROR: 'Database user or password is wrong, or the user has no access to the database.',
  ER_BAD_DB_ERROR: 'The database does not exist. Check DB_NAME.',
  ECONNREFUSED: 'Cannot reach MySQL. Try DB_HOST=127.0.0.1 or set DB_SOCKET.',
  MISSING_ENV: 'A required environment variable is missing.',
  ER_NO_SUCH_TABLE: 'The database tables are missing. Remove AUTO_MIGRATE=false (or run `node app.js migrate`) and restart the app.',
  MIGRATION_FAILED: 'Creating or updating the database tables failed. The database user needs CREATE, ALTER, INDEX, REFERENCES and DROP privileges.',
  BOOT_LOCK_TIMEOUT: 'Another process is still starting the app. Wait a minute and refresh.',
};

/** Runs migrations one process at a time (several app processes may start together on shared hosts). */
async function bootDatabase(knex, work) {
  await knex.transaction(async (trx) => {
    const [[{ got }]] = await trx.raw("SELECT GET_LOCK('docbook_boot', 180) AS got");
    if (got !== 1) throw Object.assign(new Error('Timed out waiting for another process'), { code: 'BOOT_LOCK_TIMEOUT' });
    try {
      if (await knex.schema.hasTable('knex_migrations_lock')) {
        const row = await knex('knex_migrations_lock').first();
        if (row && row.is_locked) await knex.migrate.forceFreeMigrationsLock();
      }
      await work();
    } finally {
      await trx.raw("SELECT RELEASE_LOCK('docbook_boot')");
    }
  });
}

function serveSetupError(err) {
  const code = err.code || (/Missing required environment variable/.test(err.message) ? 'MISSING_ENV' : 'STARTUP_ERROR');
  const hint = HINTS[code] || 'The application could not start. Check the server log.';
  // The database's own message says what is missing (table, privilege); it holds no credentials.
  const detail = code === 'MISSING_ENV' ? err.message : err.sqlMessage ? `${err.code}: ${err.sqlMessage}` : code;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(brand.name)} — setup</title>
<style>body{font-family:system-ui,sans-serif;background:${brand.colors.light.background};color:${brand.colors.light.text};display:grid;place-items:center;min-height:100vh;margin:0}
.c{background:#fff;border:1px solid ${brand.colors.light.border};border-radius:16px;padding:32px;max-width:520px;margin:16px}code{background:#f1f1f1;padding:2px 6px;border-radius:6px}</style></head>
<body><div class="c"><h1 style="font-size:20px">${escapeHtml(brand.name)} needs setup</h1><p>${escapeHtml(hint)}</p><p>Error: <code>${escapeHtml(detail)}</code></p></div></body></html>`;
  http.createServer((req, res) => {
    res.writeHead(503, { 'Content-Type': req.url === '/healthz' ? 'application/json' : 'text/html; charset=utf-8', 'Retry-After': '60' });
    res.end(req.url === '/healthz' ? JSON.stringify({ status: 'setup_error', code: detail }) : html);
  }).listen(PORT);
  setTimeout(() => process.exit(1), 60_000).unref();
}

async function start() {
  const config = require('./config');
  const knex = require('./db/knex');
  const { createApp } = require('./app');
  await knex.raw('select 1');
  if (config.autoMigrate) {
    await bootDatabase(knex, async () => {
      const [, applied] = await knex.migrate.latest().catch((e) => {
        throw Object.assign(new Error(`Migration failed: ${e.message}`), { code: 'MIGRATION_FAILED', sqlMessage: e.sqlMessage || e.message });
      });
      if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`); // eslint-disable-line no-console
    });
  }
  // Platform super admin from SUPER_ADMIN_* (never overwrites an existing password).
  await require('./modules/rbac/rbac.service').syncSystemRoles(); // eslint-disable-line global-require
  await require('./modules/auth/auth.service').ensureSuperAdmin() // eslint-disable-line global-require
    .catch((e) => console.error('[auth] could not ensure the platform admin:', e.message)); // eslint-disable-line no-console
  // Copies of clinic data to their own databases (Settings → Your database), checked every 5 minutes.
  if (config.env !== 'test') {
    const syncTick = () => require('./modules/datasync/datasync.service').runDue().catch((e) => console.error('[datasync]', e.message)); // eslint-disable-line global-require, no-console
    setInterval(syncTick, 5 * 60_000).unref();
    // Online consultations: reminder e-mails ~1 hour before, and old video-call signaling messages purged.
    const teleTick = () => require('./modules/telehealth/telehealth.service').runDue().catch((e) => console.error('[telehealth]', e.message)); // eslint-disable-line global-require, no-console
    setInterval(teleTick, 5 * 60_000).unref();
    // Online payments: unpaid online bookings past the clinic's hold time are released; stuck payments settled.
    const payTick = () => require('./modules/payments/payments.service').runDue().catch((e) => console.error('[payments]', e.message)); // eslint-disable-line global-require, no-console
    setInterval(payTick, 5 * 60_000).unref();
    // Appointment messages (WhatsApp / SMS / e-mail): confirmations, reminders and review requests, every minute.
    const messagingTick = () => require('./modules/messaging/messaging.service').runDue().catch((e) => console.error('[messaging]', e.message)); // eslint-disable-line global-require, no-console
    setInterval(messagingTick, 60_000).unref();
  }
  const app = createApp();
  const server = app.listen(PORT, () => console.log(`[${brand.name}] listening on ${PORT} (${config.env})`)); // eslint-disable-line no-console
  const shutdown = () => server.close(() => knex.destroy().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Starts the server. Called explicitly by app.js: hosting loaders (cPanel/CloudLinux LiteSpeed lsnode, Passenger)
 * load the startup file through their own script, so "is this the main module" checks do not work there.
 */
function run() {
  return start().catch((err) => {
    console.error(`[${brand.name}] failed to start:`, err.code || '', err.message); // eslint-disable-line no-console
    serveSetupError(err);
  });
}

if (require.main === module) run();

module.exports = { run, bootDatabase };
