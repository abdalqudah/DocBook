// Supplies, purchase orders and budgets per branch (branch_key: a branch id; null = the main branch — for budgets
// null = the whole clinic, 'main' = the main branch).
const TABLES = ['supply_items', 'purchase_orders', 'budgets'];
exports.up = async (knex) => {
  for (const t of TABLES) { // eslint-disable-line no-restricted-syntax
    if (!(await knex.schema.hasColumn(t, 'branch_key'))) await knex.schema.alterTable(t, (x) => { x.string('branch_key', 20).nullable().index(); }); // eslint-disable-line no-await-in-loop
  }
};
exports.down = async (knex) => {
  for (const t of TABLES) { // eslint-disable-line no-restricted-syntax
    if (await knex.schema.hasColumn(t, 'branch_key')) await knex.schema.alterTable(t, (x) => { x.dropColumn('branch_key'); }); // eslint-disable-line no-await-in-loop
  }
};
