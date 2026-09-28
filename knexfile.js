const path = require('path');
const config = require('./src/config');

module.exports = {
  client: 'mysql2',
  connection: { ...config.db, charset: 'utf8mb4', timezone: 'Z' },
  migrations: { directory: path.join(__dirname, 'src', 'db', 'migrations'), tableName: 'knex_migrations' },
};
