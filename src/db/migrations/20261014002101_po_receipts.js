// Each delivery received against a purchase order (quantity and cost, when it arrived). The profit & loss memo of
// supplies received counts deliveries in the month they arrived — partial deliveries and orders cancelled after a
// partial delivery included. Existing received quantities are carried over once.
exports.up = async (knex) => {
  if (await knex.schema.hasTable('purchase_receipts')) return;
  await knex.schema.createTable('purchase_receipts', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('purchase_order_id').unsigned().notNullable().references('purchase_orders.id').onDelete('CASCADE');
    t.integer('line_id').unsigned().notNullable().references('purchase_order_items.id').onDelete('CASCADE');
    t.decimal('quantity', 15, 2).notNullable();
    t.decimal('unit_cost', 15, 3).nullable();
    t.integer('received_by').unsigned().nullable();
    t.timestamp('received_at').notNullable().defaultTo(knex.fn.now());
    t.index(['business_id', 'received_at']);
  });
  const lines = await knex('purchase_order_items as l').join('purchase_orders as po', 'po.id', 'l.purchase_order_id').where('l.received_quantity', '>', 0)
    .select('l.id', 'l.received_quantity', 'l.unit_cost', 'po.id as po_id', 'po.business_id', 'po.received_at', 'po.updated_at');
  for (let i = 0; i < lines.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    await knex('purchase_receipts').insert(lines.slice(i, i + 500).map((l) => ({ business_id: l.business_id, purchase_order_id: l.po_id, line_id: l.id, quantity: l.received_quantity, unit_cost: l.unit_cost, received_at: l.received_at || l.updated_at || new Date() })));
  }
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('purchase_receipts'); };
