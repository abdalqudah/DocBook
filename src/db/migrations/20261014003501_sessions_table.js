// The sign-in sessions table (connect-session-knex) made by a migration instead of by the store at start-up, so it is
// there before a clinic's own database is built (each clinic database shows it as a view — src/db/tenant-schema.js).
// Same shape as the store's own: sid, sess (JSON), expired (indexed).
exports.up = async (knex) => {
  if (await knex.schema.hasTable('sessions')) return;
  await knex.schema.createTable('sessions', (t) => {
    t.string('sid').primary();
    t.json('sess').notNullable();
    t.dateTime('expired').notNullable().index();
  });
};
exports.down = async () => { /* the store keeps using it */ };
