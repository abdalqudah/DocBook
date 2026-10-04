// A knex instance for one MySQL database: the main (platform) database, or one clinic's / medical centre's own.
const path = require('path');
const knexFactory = require('knex');
const config = require('../config');

function connect(database, { poolMax = Number(process.env.DB_POOL_MAX || 10), migrations = true } = {}) {
  return knexFactory({
    client: 'mysql2',
    connection: {
      ...(process.env.DB_SOCKET ? { socketPath: process.env.DB_SOCKET } : { host: config.db.host, port: config.db.port }),
      user: config.db.user,
      password: config.db.password,
      database,
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
      max: poolMax,
      idleTimeoutMillis: 30_000,
      // UTC sessions: CURRENT_TIMESTAMP / NOW() must match the UTC dates the app passes in (timezone 'Z'),
      // whatever zone the database server itself runs in.
      afterCreate: (conn, done) => conn.query("SET SESSION default_storage_engine = 'InnoDB', time_zone = '+00:00'", (err) => done(err, conn)),
    },
    ...(migrations ? { migrations: { directory: path.join(__dirname, 'migrations'), tableName: 'knex_migrations' } } : {}),
  });
}

module.exports = { connect };
