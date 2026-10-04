// Each clinic (or medical centre) can have its own database (src/db/tenant.js):
//   businesses.db_name   the clinic's database (null = the main database, as before)
// Shared tables (main database) no longer point at a clinic's own tables with foreign keys — those rows move to the
// clinic's database, where a key across databases would block them. The ids stay; the app checks them.
const { isPlatform, isTenant } = require('../tables');

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('businesses', 'db_name'))) {
    await knex.schema.alterTable('businesses', (t) => { t.string('db_name', 64).nullable(); t.index(['db_name']); });
  }
  const [rows] = await knex.raw(`SELECT table_name AS t, constraint_name AS c, referenced_table_name AS r FROM information_schema.key_column_usage
    WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`);
  for (const fk of rows) { // eslint-disable-line no-restricted-syntax
    const t = fk.t || fk.TABLE_NAME; const r = fk.r || fk.REFERENCED_TABLE_NAME; const c = fk.c || fk.CONSTRAINT_NAME;
    if (isPlatform(t) && isTenant(r)) await knex.raw('ALTER TABLE ?? DROP FOREIGN KEY ??', [t, c]); // eslint-disable-line no-await-in-loop
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('businesses', 'db_name')) await knex.schema.alterTable('businesses', (t) => { t.dropIndex(['db_name']); t.dropColumn('db_name'); });
};
