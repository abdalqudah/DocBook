const config = require('./config');
const knex = require('./db/knex');
const { migrateLatest } = require('./db/migrate');

async function boot() {
  await knex.raw('select 1');
  if (config.autoMigrate) await migrateLatest();
  await require('./modules/bootstrap').run(); // eslint-disable-line global-require -- roles, first admin, jobs
  const { createApp } = require('./app'); // eslint-disable-line global-require
  return createApp();
}

async function run() {
  try {
    const app = await boot();
    const server = app.listen(config.port, () => console.log(`[gec] listening on ${config.port} (${config.env})`)); // eslint-disable-line no-console
    if (!config.isTest && config.runJobs) require('./modules/jobs').start(); // eslint-disable-line global-require
    // Graceful shutdown (deploys, container stops): finish open requests, then close the database pool.
    const stop = (sig) => {
      console.log(`[gec] ${sig}: shutting down`); // eslint-disable-line no-console
      server.close(() => knex.destroy().finally(() => process.exit(0)));
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
  } catch (e) {
    console.error('[gec] start-up failed:', e.code || '', e.message); // eslint-disable-line no-console
    process.exit(1);
  }
}

module.exports = { boot, run };
