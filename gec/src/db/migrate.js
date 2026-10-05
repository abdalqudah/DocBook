// Runs pending migrations one process at a time (several app processes may start together).
const knex = require('./knex');

async function migrateLatest() {
  await knex.transaction(async (trx) => {
    const [[{ got }]] = await trx.raw("SELECT GET_LOCK('gec_migrate', 180) AS got");
    if (got !== 1) throw Object.assign(new Error('Timed out waiting for another process to migrate'), { code: 'MIGRATE_LOCK_TIMEOUT' });
    try {
      if (await knex.schema.hasTable('knex_migrations_lock')) {
        const row = await knex('knex_migrations_lock').first();
        if (row && row.is_locked) await knex.migrate.forceFreeMigrationsLock();
      }
      const [, applied] = await knex.migrate.latest();
      if (applied.length) console.log(`[db] applied ${applied.length} migration(s)`); // eslint-disable-line no-console
    } finally {
      await trx.raw("SELECT RELEASE_LOCK('gec_migrate')");
    }
  });
}

module.exports = { migrateLatest };
