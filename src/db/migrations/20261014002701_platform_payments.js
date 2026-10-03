// Card payments to the platform (PayTabs): a clinic paying its subscription invoice or a rep paying its plan / ad
// invoice. One row per attempt; the result is always asked from PayTabs' server, never taken from the browser.
exports.up = async (knex) => {
  if (await knex.schema.hasTable('platform_payments')) return;
  await knex.schema.createTable('platform_payments', (t) => {
    t.increments('id');
    t.string('public_id', 40).notNullable().unique();
    t.string('kind', 10).notNullable(); // clinic | vendor
    t.integer('invoice_id').unsigned().notNullable(); // platform_invoices.id or vendor_invoices.id
    t.integer('business_id').unsigned().nullable().references('businesses.id').onDelete('CASCADE');
    t.integer('vendor_id').unsigned().nullable().references('vendors.id').onDelete('CASCADE');
    t.decimal('amount', 12, 3).notNullable();
    t.string('currency', 3).notNullable();
    t.string('provider', 20).notNullable().defaultTo('paytabs');
    t.string('provider_ref', 80).nullable();
    t.string('status', 12).notNullable().defaultTo('pending'); // pending | paid | failed | cancelled
    t.string('result_code', 20).nullable();
    t.string('message', 250).nullable();
    t.text('raw').nullable();
    t.integer('user_id').unsigned().nullable();
    t.timestamp('paid_at').nullable();
    t.timestamps(true, true);
    t.index(['kind', 'invoice_id']);
  });
};
exports.down = (knex) => knex.schema.dropTableIfExists('platform_payments');
