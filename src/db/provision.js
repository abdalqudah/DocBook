// Creating a clinic's own database on the server. Chosen in .env (never shown in the app):
//   TENANT_DB_DRIVER=off      every clinic stays in the main database (default)
//   TENANT_DB_DRIVER=mysql    CREATE DATABASE with the app's own database user (a VPS / dedicated server)
//   TENANT_DB_DRIVER=cpanel   the cPanel API: CPANEL_URL (https://host:2083), CPANEL_USER, CPANEL_TOKEN (an API token
//                             from cPanel → Security → Manage API Tokens); the new database is given to DB_USER
//   TENANT_DB_PREFIX          name prefix (default <DB_NAME>_c → e.g. cpuser_docbook_c12; cPanel needs "cpuser_")
const config = require('../config');

const DRIVER = (process.env.TENANT_DB_DRIVER || 'off').toLowerCase();
const PREFIX = process.env.TENANT_DB_PREFIX || `${config.db.database}_c`;
const enabled = () => DRIVER === 'mysql' || DRIVER === 'cpanel';
const q = (s) => `\`${String(s).replace(/`/g, '')}\``;

async function uapi(mod, fn, params) {
  const base = String(process.env.CPANEL_URL || '').replace(/\/+$/, '');
  if (!base || !process.env.CPANEL_USER || !process.env.CPANEL_TOKEN) throw new Error('cPanel API is not configured (CPANEL_URL, CPANEL_USER, CPANEL_TOKEN).');
  const res = await fetch(`${base}/execute/${mod}/${fn}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `cpanel ${process.env.CPANEL_USER}:${process.env.CPANEL_TOKEN}` }, signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.status) throw new Error(`cPanel ${mod}::${fn} failed: ${((body && body.errors) || [res.status]).join('; ')}`);
  return body.data;
}

/** Creates an empty database `name` that the app's database user can use. */
async function createDatabase(main, name) {
  if (DRIVER === 'cpanel') {
    await uapi('Mysql', 'create_database', { name });
    await uapi('Mysql', 'set_privileges_on_database', { user: config.db.user, database: name, privileges: 'ALL PRIVILEGES' });
    return;
  }
  if (DRIVER !== 'mysql') throw new Error('Separate clinic databases are off (TENANT_DB_DRIVER).');
  const [[cs]] = await main.raw('SELECT default_character_set_name AS c, default_collation_name AS o FROM information_schema.schemata WHERE schema_name = DATABASE()');
  await main.raw(`CREATE DATABASE IF NOT EXISTS ${q(name)} CHARACTER SET ${cs.c || cs.DEFAULT_CHARACTER_SET_NAME} COLLATE ${cs.o || cs.DEFAULT_COLLATION_NAME}`);
}

async function dropDatabase(main, name) {
  if (DRIVER === 'cpanel') { await uapi('Mysql', 'delete_database', { name }); return; }
  await main.raw(`DROP DATABASE IF EXISTS ${q(name)}`);
}

module.exports = { DRIVER, PREFIX, enabled, createDatabase, dropDatabase };
