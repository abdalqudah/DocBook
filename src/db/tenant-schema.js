// A clinic's own database (see tenant.js), built from the main database's structure and kept in step with it:
//   • every clinic table (tables.js TENANT) as a real table — same columns, indexes and foreign keys; a key to a
//     shared table points at the main database (`main`.`users`), one to a clinic table stays inside the database;
//   • every shared table (tables.js PLATFORM) as a view of the main one, so queries and joins work unchanged;
//   • its own block of ids (tenant_dbs.block): rows created in different databases never share an id, so a
//     clinic can later move into a medical centre's database without renumbering anything.
//   build(db)   create the tables and views of a new (empty) database
//   sync(db)    after the main database was migrated: add / change / drop columns, indexes and keys to match, create
//               new tables, refresh the views (a view's column list is fixed when it is made)
const { PLATFORM, TENANT } = require('./tables');

const BLOCK = 1_000_000; // ids per table per database
const FIRST_BLOCK = 10; // the main database keeps the ids below 10 000 000
const q = (s) => `\`${String(s).replace(/`/g, '')}\``;
const VIEW_SKIP = new Set(['knex_migrations', 'knex_migrations_lock']);

/** Lines of SHOW CREATE TABLE, split into columns / keys / constraints (by name). */
function parse(ddl) {
  const body = ddl.slice(ddl.indexOf('(\n') + 2, ddl.lastIndexOf('\n)'));
  const out = { columns: new Map(), order: [], keys: new Map(), constraints: new Map() };
  for (const raw of body.split('\n')) { // eslint-disable-line no-restricted-syntax
    const line = raw.trim().replace(/,$/, '');
    if (!line) continue; // eslint-disable-line no-continue
    let m;
    if ((m = /^`([^`]+)`/.exec(line))) { out.columns.set(m[1], line); out.order.push(m[1]); } else if (/^PRIMARY KEY/.test(line)) out.keys.set('PRIMARY', line);
    else if ((m = /^(?:UNIQUE |FULLTEXT |SPATIAL )?KEY `([^`]+)`/.exec(line))) out.keys.set(m[1], line);
    else if ((m = /^CONSTRAINT `([^`]+)`/.exec(line))) out.constraints.set(m[1], line);
  }
  return out;
}

/** A clinic table's CREATE statement for a clinic database: keys to shared tables point at the main database. */
function qualify(text, mainDb) {
  return text.replace(/REFERENCES `([^`.]+)` \(/g, (all, t) => (PLATFORM.includes(t) ? `REFERENCES ${q(mainDb)}.${q(t)} (` : all));
}

async function createDdl(k, mainDb, table) {
  const [[row]] = await k.raw(`SHOW CREATE TABLE ${q(mainDb)}.${q(table)}`);
  return row['Create Table'];
}

async function blockOf(k, db) {
  const row = await k('tenant_dbs').where({ db_name: db }).first('block');
  return row ? row.block * BLOCK : null;
}

async function createTable(k, mainDb, db, table, start) {
  let ddl = qualify(await createDdl(k, mainDb, table), mainDb).replace(/ AUTO_INCREMENT=\d+/, '');
  ddl = ddl.replace(/^CREATE TABLE `[^`]+`/, `CREATE TABLE ${q(db)}.${q(table)}`);
  if (start) ddl += ` AUTO_INCREMENT=${start}`;
  await k.raw(ddl);
}

async function refreshViews(k, mainDb, db) {
  const [rows] = await k.raw('SELECT table_name AS t, table_type AS y FROM information_schema.tables WHERE table_schema = ?', [db]);
  const existing = new Map(rows.map((r) => [r.t || r.TABLE_NAME, r.y || r.TABLE_TYPE]));
  const [mainRows] = await k.raw("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'", [mainDb]);
  const inMain = new Set(mainRows.map((r) => r.t || r.TABLE_NAME));
  for (const t of PLATFORM) { // eslint-disable-line no-restricted-syntax
    if (VIEW_SKIP.has(t) || !inMain.has(t)) continue; // eslint-disable-line no-continue
    if (existing.get(t) === 'BASE TABLE') throw new Error(`${db}.${t} is a table, expected a view of the shared table`);
    await k.raw(`CREATE OR REPLACE SQL SECURITY INVOKER VIEW ${q(db)}.${q(t)} AS SELECT * FROM ${q(mainDb)}.${q(t)}`); // eslint-disable-line no-await-in-loop
  }
  // A shared table that no longer exists: its view goes too.
  for (const [t, type] of existing) if (type === 'VIEW' && !inMain.has(t)) await k.raw(`DROP VIEW IF EXISTS ${q(db)}.${q(t)}`); // eslint-disable-line no-restricted-syntax, no-await-in-loop
}

/** Runs fn on one connection with foreign key checks off (tables are created / changed in any order). */
async function noChecks(k, fn) {
  return k.transaction(async (trx) => {
    await trx.raw('SET FOREIGN_KEY_CHECKS = 0');
    try { return await fn(trx); } finally { await trx.raw('SET FOREIGN_KEY_CHECKS = 1'); }
  });
}

async function build(k, mainDb, db) {
  const start = await blockOf(k, db);
  await noChecks(k, async (trx) => {
    for (const t of TENANT) await createTable(trx, mainDb, db, t, start); // eslint-disable-line no-restricted-syntax, no-await-in-loop
  });
  await refreshViews(k, mainDb, db);
}

/** Brings one clinic database in line with the main database's structure. Returns the changes made. */
async function sync(k, mainDb, db) {
  const changes = [];
  const start = await blockOf(k, db);
  const [rows] = await k.raw("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'", [db]);
  const have = new Set(rows.map((r) => r.t || r.TABLE_NAME));
  await noChecks(k, async (trx) => {
    for (const t of TENANT) { // eslint-disable-line no-restricted-syntax
      if (!have.has(t)) { await createTable(trx, mainDb, db, t, start); changes.push(`+${t}`); continue; } // eslint-disable-line no-await-in-loop, no-continue
      const want = parse(qualify(await createDdl(trx, mainDb, t), mainDb)); // eslint-disable-line no-await-in-loop
      const got = parse(await createDdl(trx, db, t)); // eslint-disable-line no-await-in-loop
      const alters = [];
      for (const [name, line] of got.constraints) if (want.constraints.get(name) !== line) alters.push(/ CHECK /.test(line) ? `DROP CONSTRAINT ${q(name)}` : `DROP FOREIGN KEY ${q(name)}`); // eslint-disable-line no-restricted-syntax
      if (alters.length) { await trx.raw(`ALTER TABLE ${q(db)}.${q(t)} ${alters.join(', ')}`); changes.push(`${t}: ${alters.join(', ')}`); alters.length = 0; } // eslint-disable-line no-await-in-loop
      for (const [name, line] of got.keys) if (want.keys.get(name) !== line) alters.push(name === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${q(name)}`); // eslint-disable-line no-restricted-syntax
      want.order.forEach((c, i) => {
        const def = want.columns.get(c);
        if (!got.columns.has(c)) alters.push(`ADD COLUMN ${def} ${i ? `AFTER ${q(want.order[i - 1])}` : 'FIRST'}`);
        else if (got.columns.get(c) !== def) alters.push(`MODIFY COLUMN ${def}`);
      });
      for (const c of got.order) if (!want.columns.has(c)) alters.push(`DROP COLUMN ${q(c)}`); // eslint-disable-line no-restricted-syntax
      for (const [name, line] of want.keys) if (got.keys.get(name) !== line) alters.push(`ADD ${line}`); // eslint-disable-line no-restricted-syntax
      for (const [name, line] of want.constraints) if (got.constraints.get(name) !== line) alters.push(`ADD ${line}`); // eslint-disable-line no-restricted-syntax
      if (alters.length) { await trx.raw(`ALTER TABLE ${q(db)}.${q(t)} ${alters.join(', ')}`); changes.push(`${t}: ${alters.length} change(s)`); } // eslint-disable-line no-await-in-loop
    }
  });
  await refreshViews(k, mainDb, db);
  return changes;
}

module.exports = { BLOCK, FIRST_BLOCK, parse, qualify, build, sync, refreshViews };
