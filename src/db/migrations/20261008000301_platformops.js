// Platform operations for a clinic:
//  • clinic_ops_settings: one row per clinic — which optional areas are turned off (JSON list of module keys; an
//    absent row means everything is on) and the invoice print template (JSON). Turning an area off never deletes data.
//  • service_categories + services.category_id: optional grouping of services (staff list, public page, booking).
//  • demo_records: registry of the sample rows created by "Add sample data", so "Remove sample data" deletes
//    exactly those rows (and what hangs off them) and never anything the clinic entered itself.
exports.up = async (knex) => {
  await knex.schema.createTable('clinic_ops_settings', (t) => {
    t.integer('business_id').unsigned().notNullable().primary().references('businesses.id').onDelete('CASCADE');
    t.text('disabled_modules');   // JSON array of module keys that are off
    t.text('invoice_template');   // JSON { paper, show_*, prefix, footer, footer_en }
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('service_categories', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.string('name_en', 120);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.index(['business_id', 'sort_order']);
  });
  await knex.schema.alterTable('services', (t) => {
    t.integer('category_id').unsigned().nullable().references('service_categories.id').onDelete('SET NULL');
  });

  await knex.schema.createTable('demo_records', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('table_name', 64).notNullable();
    t.integer('record_id').unsigned().notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['business_id', 'table_name', 'record_id']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('demo_records');
  await knex.schema.alterTable('services', (t) => { t.dropForeign(['category_id']); t.dropColumn('category_id'); });
  await knex.schema.dropTableIfExists('service_categories');
  await knex.schema.dropTableIfExists('clinic_ops_settings');
};
