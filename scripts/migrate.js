const knex = require('../src/db/knex');

knex.migrate.latest()
  .then(([, applied]) => { console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.'); })
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => knex.destroy());
