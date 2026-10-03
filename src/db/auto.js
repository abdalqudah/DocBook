// Keeps the database up to date by itself, so nobody has to run `npx knex migrate:latest` after an update:
//   • on start (src/server.js, AUTO_MIGRATE on by default),
//   • every few minutes while running — new files copied onto the server without a restart are picked up,
//   • when a page fails because a table or column is missing (an update whose migrations have not run yet),
//   • from Admin → Updates ("Update the database now").
// One run at a time per process; the migrations themselves are resumable (src/db/migrate.js) and additive.
const config = require('../config');

let running = null;
let lastRun = null;
const MISSING = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR']);

/** The migrations not applied yet (file names). */
async function pending(knex = require('./knex')) { // eslint-disable-line global-require
  const [, todo] = await knex.migrate.list();
  return todo.map((m) => (m && (m.file || m.name)) || String(m));
}

/** Applies what is pending (single-flight). Resolves to the list applied. */
function ensureLatest({ knex = require('./knex'), reason = 'check' } = {}) { // eslint-disable-line global-require
  if (running) return running;
  running = (async () => {
    const todo = await pending(knex);
    if (!todo.length) return [];
    const [, applied] = await require('./migrate').migrateLatest(knex); // eslint-disable-line global-require
    if (applied.length && !config.isTest) console.log(`[db] ${reason}: applied migrations: ${applied.join(', ')}`); // eslint-disable-line no-console
    require('../core/cache').forgetPrefix(''); // eslint-disable-line global-require
    lastRun = { at: new Date(), applied, reason };
    return applied;
  })().finally(() => { running = null; });
  return running;
}

/** A database error meaning "this version's tables are not there yet". */
const isMissingSchema = (err) => Boolean(err && MISSING.has(err.code));

/** Background check every few minutes (skipped when AUTO_MIGRATE=false). */
function watch(intervalMs = 5 * 60_000) {
  if (!config.autoMigrate || config.isTest) return null;
  const tick = () => ensureLatest({ reason: 'scheduled' }).catch((e) => console.error('[db] update check failed:', e.message)); // eslint-disable-line no-console
  return setInterval(tick, intervalMs).unref();
}

module.exports = { pending, ensureLatest, isMissingSchema, watch, lastRun: () => lastRun };
