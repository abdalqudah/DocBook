// Test runs with every clinic in a separate database (TENANT_TEST_DB, see tenant.js): test files roll the main
// database back and migrate it again, so the clinic database is emptied before a rollback (its keys point at the main
// tables) and rebuilt — or brought in step — after migrating.
const tenant = require('./tenant');

const q = (s) => `\`${String(s).replace(/`/g, '')}\``;

async function empty() {
  const k = tenant.main;
  await k.raw(`DROP DATABASE IF EXISTS ${q(tenant.TEST_DB)}`);
  await k.raw(`CREATE DATABASE ${q(tenant.TEST_DB)} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
}

async function ready() {
  const k = tenant.main;
  if (!(await k.schema.hasTable('tenant_dbs'))) return;
  if (!(await k('tenant_dbs').where({ db_name: tenant.TEST_DB }).first('id'))) await k('tenant_dbs').insert({ db_name: tenant.TEST_DB, block: 10, driver: 'mysql' });
  const [[t]] = await k.raw("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'", [tenant.TEST_DB]);
  if (!Number(t.n)) { await require('./tenant-schema').build(k, tenant.MAIN, tenant.TEST_DB); return; } // eslint-disable-line global-require
  const cols = async (db) => (await k.raw('SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ?', [db]))[0][0].n;
  const [a, b] = [await cols(tenant.MAIN), await cols(tenant.TEST_DB)];
  if (a !== b) await require('./tenant-schema').sync(k, tenant.MAIN, tenant.TEST_DB); // eslint-disable-line global-require
}

/** knex.migrate for test runs: the clinic database follows the main one. */
function migrator(m) {
  return new Proxy(m, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      if (prop === 'rollback' || prop === 'down') return async (...args) => { await empty(); return v.apply(target, args); };
      if (prop === 'latest' || prop === 'up') return async (...args) => { const r = await v.apply(target, args); await ready(); return r; };
      return v.bind(target);
    },
  });
}

module.exports = { migrator, empty, ready };
