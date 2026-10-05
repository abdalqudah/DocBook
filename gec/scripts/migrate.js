const knex = require('../src/db/knex');
const { migrateLatest } = require('../src/db/migrate');

const cmd = process.argv[2] || 'latest';
(async () => {
  if (cmd === 'rollback') console.log(await knex.migrate.rollback()); // eslint-disable-line no-console
  else await migrateLatest();
  await knex.destroy();
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); }); // eslint-disable-line no-console
