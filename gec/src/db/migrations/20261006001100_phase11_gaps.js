// Phase 11 — events and courses get an owner (branch / organiser) so their registrants follow data scope; the media
// library gets alt texts; online card payments get a checkout-session table.
exports.up = async (knex) => {
  await knex.schema.alterTable('events', (t) => {
    t.integer('branch_id').unsigned().nullable().references('branches.id').onDelete('SET NULL');
    t.integer('organizer_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('courses', (t) => {
    t.integer('branch_id').unsigned().nullable().references('branches.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('media', (t) => {
    t.string('alt_en', 255); t.string('alt_ar', 255);
    t.string('source_url', 500); // where an imported image came from (credit / re-import)
    t.integer('width').unsigned().nullable(); t.integer('height').unsigned().nullable();
    t.index(['purpose', 'is_public']);
  });
  await knex.schema.createTable('payment_sessions', (t) => {
    t.increments('id');
    t.integer('invoice_id').unsigned().notNullable().references('invoices.id').onDelete('CASCADE');
    t.string('provider', 20).notNullable();
    t.string('session_id', 255).notNullable().unique();
    t.decimal('amount', 12, 2).notNullable(); t.string('currency', 3).notNullable();
    t.enum('status', ['open', 'paid', 'expired', 'failed']).notNullable().defaultTo('open');
    t.string('provider_payment_id', 255);
    t.integer('payment_id').unsigned().nullable().references('payments.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['invoice_id', 'status']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('payment_sessions');
  await knex.schema.alterTable('media', (t) => { t.dropIndex(['purpose', 'is_public']); t.dropColumn('alt_en'); t.dropColumn('alt_ar'); t.dropColumn('source_url'); t.dropColumn('width'); t.dropColumn('height'); });
  await knex.schema.alterTable('courses', (t) => { t.dropForeign(['branch_id']); t.dropColumn('branch_id'); });
  await knex.schema.alterTable('events', (t) => { t.dropForeign(['branch_id']); t.dropForeign(['organizer_id']); t.dropColumn('branch_id'); t.dropColumn('organizer_id'); });
};
