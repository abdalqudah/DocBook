// The single database connection pool (MySQL 8 / MariaDB 10.6+). All times are stored in UTC.
const knexFactory = require('knex');
const path = require('path');
const config = require('../config');

const knex = knexFactory({
  client: 'mysql2',
  connection: { ...config.db, charset: 'utf8mb4', timezone: 'Z', dateStrings: false, supportBigNumbers: true, decimalNumbers: true },
  pool: { min: 0, max: config.dbPoolMax },
  migrations: { directory: path.join(__dirname, 'migrations'), tableName: 'knex_migrations' },
});

module.exports = knex;
