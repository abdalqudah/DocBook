// A service may have no set length ("no fixed time"): its appointments then take the doctor's usual appointment length.
exports.up = async (knex) => {
  await knex.schema.alterTable('services', (t) => { t.integer('duration_minutes').nullable().defaultTo(null).alter(); });
};
exports.down = async (knex) => {
  await knex('services').whereNull('duration_minutes').update({ duration_minutes: 30 });
  await knex.schema.alterTable('services', (t) => { t.integer('duration_minutes').notNullable().defaultTo(30).alter(); });
};
