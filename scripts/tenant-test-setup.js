// Prepares the separate-database test run (see test/README or docs): a fresh main database and one clinic database
// that every clinic of the test run uses. Usage:
//   NODE_ENV=test DB_NAME_TEST=docbook_test_sep TENANT_TEST_DB=docbook_test_sep_t node scripts/tenant-test-setup.js
process.env.NODE_ENV = 'test';
const main = process.env.DB_NAME_TEST;
const tdb = process.env.TENANT_TEST_DB;
if (!main || !tdb) { console.error('Set DB_NAME_TEST and TENANT_TEST_DB.'); process.exit(1); }
(async () => {
  const { connect } = require('../src/db/connection');
  const config = require('../src/config');
  const boot = connect(config.db.database, { migrations: false });
  // Recreate both (dropping needs a connection to some database: the main one is re-created first).
  const root = connect(null, { migrations: false });
  await root.raw(`DROP DATABASE IF EXISTS \`${tdb}\``);
  await root.raw(`DROP DATABASE IF EXISTS \`${main}\``);
  await root.raw(`CREATE DATABASE \`${main}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  await root.raw(`CREATE DATABASE \`${tdb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  await root.destroy(); await boot.destroy();
  const knex = require('../src/db/knex');
  const { migrateLatest } = require('../src/db/migrate');
  await migrateLatest(knex.main, () => {});
  await knex.main('tenant_dbs').insert({ db_name: tdb, block: 10, driver: 'mysql' });
  await require('../src/db/tenant-schema').build(knex.main, main, tdb);
  console.log(`ready: main ${main}, clinics ${tdb}`);
  await knex.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
