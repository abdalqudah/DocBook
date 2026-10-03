// A purchase order's supplier bill as an expense: receiving goods records the delivered value as an expense
// ("medical supplies") linked to the order, so it shows in Expenses and the P&L without being typed again.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('expenses', 'purchase_order_id'))) {
    await knex.schema.alterTable('expenses', (t) => {
      t.integer('purchase_order_id').unsigned().nullable().references('purchase_orders.id').onDelete('SET NULL');
      t.index(['business_id', 'purchase_order_id']);
    });
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('expenses', 'purchase_order_id')) {
    await knex.schema.alterTable('expenses', (t) => { t.dropForeign('purchase_order_id'); t.dropIndex(['business_id', 'purchase_order_id']); t.dropColumn('purchase_order_id'); });
  }
};
