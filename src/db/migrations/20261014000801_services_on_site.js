// The clinic decides what its website and online booking show: each main service (category) and each sub-service
// can be hidden from the site (still usable inside the clinic and on the doctor's bill). Shown by default.
exports.up = async (knex) => {
  await knex.schema.alterTable('services', (t) => { t.boolean('show_on_site').notNullable().defaultTo(true); });
  await knex.schema.alterTable('service_categories', (t) => { t.boolean('show_on_site').notNullable().defaultTo(true); });
};
exports.down = async (knex) => {
  await knex.schema.alterTable('services', (t) => { t.dropColumn('show_on_site'); });
  await knex.schema.alterTable('service_categories', (t) => { t.dropColumn('show_on_site'); });
};
