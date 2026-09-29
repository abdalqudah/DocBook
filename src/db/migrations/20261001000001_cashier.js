// Cashier (POS-style patient payments) and cash-drawer closings — DocBook's POS cash register closings, for clinics.
//  • invoices.items: the bill lines [{ name, qty, unitPrice, serviceId? }] when more than the booked service is charged
//  • invoices.amount_received / change_due: cash handed over and change given back (cash payments)
//  • cash_closings: one row per drawer count; expected cash = cash invoices since the previous closing (server clock)
exports.up = async (knex) => {
  await knex.schema.alterTable('invoices', (t) => {
    t.json('items').nullable();
    t.decimal('subtotal', 12, 2).nullable();
    t.decimal('amount_received', 12, 2).nullable();
    t.decimal('change_due', 12, 2).nullable();
  });
  await knex.schema.createTable('cash_closings', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.datetime('period_start').notNullable();
    t.datetime('period_end').notNullable();
    t.decimal('expected_cash', 12, 2).notNullable().defaultTo(0);
    t.decimal('counted_cash', 12, 2).notNullable().defaultTo(0);
    t.decimal('variance', 12, 2).notNullable().defaultTo(0);
    t.integer('invoice_count').unsigned().notNullable().defaultTo(0);
    t.integer('closed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'period_end']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('cash_closings');
  await knex.schema.alterTable('invoices', (t) => { t.dropColumn('items'); t.dropColumn('subtotal'); t.dropColumn('amount_received'); t.dropColumn('change_due'); });
};
