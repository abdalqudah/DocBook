// Demo data: `npm run seed` adds it, `npm run seed -- --remove` deletes every demo row. Never run on production data
// you care about without --remove afterwards; demo rows are flagged and shown with a "Demo" chip.
const knex = require('../src/db/knex');
const { migrateLatest } = require('../src/db/migrate');
const bootstrap = require('../src/modules/bootstrap');

const SEEDS = ['demo-crm', 'demo-catalog', 'demo-engagement', 'demo-cms'];

(async () => {
  await migrateLatest();
  await bootstrap.run();
  const remove = process.argv.includes('--remove');
  for (const name of remove ? [...SEEDS].reverse() : SEEDS) {
    let mod;
    try { mod = require(`../src/db/seeds/${name}`); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(name)) continue; throw e; } // eslint-disable-line
    const r = remove ? await mod.remove() : await mod.run(); // eslint-disable-line no-await-in-loop
    console.log(`${remove ? 'removed' : 'seeded'} ${name}`, r || ''); // eslint-disable-line no-console
  }
  await knex.destroy();
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); }); // eslint-disable-line no-console
