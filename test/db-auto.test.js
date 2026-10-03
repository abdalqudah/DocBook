// The database keeps itself up to date: pending migrations are found and applied by the running app (no command).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auto = require('../src/db/auto');

test.after(() => knex.destroy());

test('pending migrations are detected and applied, once at a time', async () => {
  await knex.migrate.latest();
  assert.deepEqual(await auto.pending(), []);
  // Undo the newest migration, as if a new version's files arrived without its database changes.
  const [, done] = await knex.migrate.list();
  await knex.migrate.down();
  const waiting = await auto.pending();
  assert.equal(waiting.length, 1);
  const [a, b] = [auto.ensureLatest({ reason: 'test' }), auto.ensureLatest({ reason: 'test' })];
  assert.equal(a, b, 'one run at a time');
  assert.deepEqual((await a).length, 1);
  assert.deepEqual(await auto.pending(), []);
  assert.ok(done.length >= 0);
  assert.ok(auto.isMissingSchema({ code: 'ER_NO_SUCH_TABLE' }) && auto.isMissingSchema({ code: 'ER_BAD_FIELD_ERROR' }) && !auto.isMissingSchema({ code: 'ER_DUP_ENTRY' }));
});
