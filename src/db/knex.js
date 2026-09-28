const path = require('path');
const knexFactory = require('knex');
const config = require('../config');

const knex = knexFactory({
  client: 'mysql2',
  connection: {
    ...(process.env.DB_SOCKET ? { socketPath: process.env.DB_SOCKET } : { host: config.db.host, port: config.db.port }),
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: 'utf8mb4',
    timezone: 'Z',
    decimalNumbers: true,
    supportBigNumbers: true,
    // DATE columns come back as 'YYYY-MM-DD' strings (DocBook's whole engine keys on that format).
    dateStrings: ['DATE'],
    typeCast(field, next) {
      if (field.type === 'JSON') { const v = field.string('utf8'); try { return v === null ? null : JSON.parse(v); } catch { return v; } }
      return next();
    },
  },
  pool: {
    min: 0,
    max: Number(process.env.DB_POOL_MAX || 10),
    afterCreate: (conn, done) => conn.query("SET SESSION default_storage_engine = 'InnoDB'", (err) => done(err, conn)),
  },
  migrations: { directory: path.join(__dirname, 'migrations'), tableName: 'knex_migrations' },
});

module.exports = knex;
