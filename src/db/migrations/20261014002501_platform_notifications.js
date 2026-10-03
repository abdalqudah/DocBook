// Notifications outside a clinic: for the platform admin (audience 'admin': new clinics and reps, payments to
// confirm, ads, articles) and for reps & warehouses (audience 'vendor': visit decisions, purchase orders, plan and
// ad status, trial ending). Stored as a message key + params so each reader sees it in their own language.
exports.up = async (knex) => {
  if (await knex.schema.hasTable('platform_notifications')) return;
  await knex.schema.createTable('platform_notifications', (t) => {
    t.increments('id');
    t.string('audience', 10).notNullable(); // admin | vendor
    t.integer('vendor_id').unsigned().nullable().references('vendors.id').onDelete('CASCADE');
    t.string('kind', 60).notNullable();
    t.text('params').nullable();
    t.string('link', 300).nullable();
    t.string('severity', 10).notNullable().defaultTo('info'); // info | success | warning
    t.string('dedupe_key', 120).nullable();
    t.timestamp('read_at').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['audience', 'vendor_id', 'read_at']);
    t.index(['audience', 'vendor_id', 'dedupe_key']);
  });
};
exports.down = (knex) => knex.schema.dropTableIfExists('platform_notifications');
