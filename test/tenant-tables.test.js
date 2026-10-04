// Every table of the database is classified once: shared (main database) or a clinic's own (src/db/tables.js).
// A new table must be added there, or a clinic with its own database would not get it (or get an empty copy).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const { PLATFORM, TENANT } = require('../src/db/tables');

test.after(() => knex.destroy());

test('every table is either shared or a clinic\'s own, never both', async () => {
  await knex.main.migrate.latest();
  const [rows] = await knex.main.raw("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
  const tables = rows.map((r) => r.t || r.TABLE_NAME);
  const both = PLATFORM.filter((t) => TENANT.includes(t));
  assert.deepEqual(both, []);
  const missing = tables.filter((t) => !PLATFORM.includes(t) && !TENANT.includes(t));
  assert.deepEqual(missing, [], `unclassified tables: ${missing.join(', ')}`);
  const gone = [...PLATFORM, ...TENANT].filter((t) => !tables.includes(t));
  assert.deepEqual(gone, [], `classified tables that do not exist: ${gone.join(', ')}`);
});
