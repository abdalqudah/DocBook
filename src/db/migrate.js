// Runs the migrations so that a run interrupted half-way (the host stopped the process while it was starting)
// can simply be run again. MySQL commits every CREATE/ALTER TABLE on its own, so after an interruption part of a
// migration is already in the database while knex still has it as "not run". On the re-run, a table, column,
// index or foreign key that already exists from that earlier attempt is skipped instead of failing. Each such
// statement is atomic in MySQL, so "already exists" means the earlier attempt applied it completely.
const ALREADY_THERE = new Set([
  'ER_TABLE_EXISTS_ERROR', // table exists
  'ER_DUP_FIELDNAME', // column exists
  'ER_DUP_KEYNAME', // index exists
  'ER_FK_DUP_NAME', // foreign key exists
  'ER_DUP_KEY', // foreign key exists (older MySQL / MariaDB message)
  'ER_CANT_DROP_FIELD_OR_KEY', // column or index already dropped
]);
const DDL = /^\s*(create\s+(table|(unique\s+)?index)|alter\s+table)\b/i;

async function migrateLatest(knex, log = console.log) { // eslint-disable-line no-console
  // Migrations run inside transactions, whose clients knex builds from the client's class prototype, so the
  // wrapper goes on that prototype for the duration of the run (nothing else queries while the app boots).
  const proto = knex.client.constructor.prototype;
  const own = Object.prototype.hasOwnProperty.call(proto, 'query');
  const { query } = proto;
  proto.query = function resumable(connection, obj) {
    return query.call(this, connection, obj).catch((e) => {
      const sql = typeof obj === 'string' ? obj : obj && obj.sql;
      // MariaDB reports an existing foreign key as "Can't create table … (errno: 121 "Duplicate key …")".
      const dupForeignKey = e.code === 'ER_CANT_CREATE_TABLE' && /errno: 121/.test(e.sqlMessage || '');
      if ((ALREADY_THERE.has(e.code) || dupForeignKey) && DDL.test(sql || '')) {
        log(`[db] already applied, skipped: ${String(sql).slice(0, 120)}`);
        return null;
      }
      throw e;
    });
  };
  try {
    return await knex.migrate.latest();
  } finally {
    if (own) proto.query = query; else delete proto.query;
  }
}

module.exports = { migrateLatest };
