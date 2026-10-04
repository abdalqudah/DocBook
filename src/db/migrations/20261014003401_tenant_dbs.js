// The clinics' own databases (src/db/tenant.js): one row each, with its block of ids (tenant-schema.js) — rows made
// in different databases never share an id, so a clinic can join a medical centre's database without renumbering.
exports.up = async (knex) => {
  if (await knex.schema.hasTable('tenant_dbs')) return;
  await knex.schema.createTable('tenant_dbs', (t) => {
    t.increments('id');
    t.string('db_name', 64).notNullable().unique();
    t.integer('block').unsigned().notNullable().unique();
    t.string('driver', 20).notNullable(); // mysql | cpanel
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('synced_at').nullable();
  });
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('tenant_dbs'); };
