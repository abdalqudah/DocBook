// Prices at the currency's full precision: purchase-order unit costs and vendor list prices were DECIMAL(12,2), so a
// JOD price in fils (0.125) was stored as 0.13 while the supply item itself keeps 3 decimals.
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('purchase_order_items', 'unit_cost')) await knex.raw('ALTER TABLE purchase_order_items MODIFY unit_cost DECIMAL(15,3) NULL');
  if (await knex.schema.hasColumn('vendor_products', 'price')) await knex.raw('ALTER TABLE vendor_products MODIFY price DECIMAL(15,3) NULL');
};
exports.down = async () => {}; // widening only: narrowing back would round stored prices
