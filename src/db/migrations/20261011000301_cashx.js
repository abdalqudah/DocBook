// Reception & cash screen (worker: reception-cash).
//  • invoice_payments: how an invoice was settled, one row per part — cash, card, bank_transfer, digital_wallet,
//    insurance. A "mixed" invoice has a cash part and a card part; an insured visit has an insurance part plus the
//    patient's part(s). The cash-drawer count (expected cash) sums ONLY the cash parts. Invoices issued before this
//    table (or by other flows that write no parts) fall back to invoices.payment_method / amount.
//  • invoices.insurance_amount: the insurer's share when the cashier entered it (percent or fixed amount).
//  • invoices.discount_reason / adjust_reason: why a discount was given / why the doctor's bill was changed.
exports.up = async (knex) => {
  await knex.schema.createTable('invoice_payments', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('invoice_id').unsigned().notNullable().references('invoices.id').onDelete('CASCADE');
    t.string('method', 30).notNullable();
    t.decimal('amount', 15, 3).notNullable().defaultTo(0);
    t.decimal('received', 15, 3).nullable(); // cash handed over for this part
    t.decimal('change_due', 15, 3).nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'invoice_id']);
  });
  await knex.schema.alterTable('invoices', (t) => {
    t.decimal('insurance_amount', 15, 3).nullable();
    t.string('discount_reason', 255).nullable();
    t.string('adjust_reason', 255).nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('invoice_payments');
  await knex.schema.alterTable('invoices', (t) => { t.dropColumn('insurance_amount'); t.dropColumn('discount_reason'); t.dropColumn('adjust_reason'); });
};
