// Branches kept apart, money too: each expense belongs to a branch (expenses.branch_id, null = the main branch), and
// each staff employee on the payroll (staff_employees.branch_key: '' the whole clinic, 'main' or a branch id; a
// doctor's pay follows its doctor's branch).
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('expenses', 'branch_id'))) await knex.schema.alterTable('expenses', (t) => { t.integer('branch_id').unsigned().nullable(); t.index(['business_id', 'branch_id', 'date'], 'exp_branch_idx'); });
  if (!(await knex.schema.hasColumn('recurring_expenses', 'branch_id')) && (await knex.schema.hasTable('recurring_expenses'))) await knex.schema.alterTable('recurring_expenses', (t) => { t.integer('branch_id').unsigned().nullable(); });
  if (!(await knex.schema.hasColumn('staff_employees', 'branch_key'))) await knex.schema.alterTable('staff_employees', (t) => { t.string('branch_key', 12).notNullable().defaultTo(''); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('expenses', 'branch_id')) await knex.schema.alterTable('expenses', (t) => { t.dropIndex(['business_id', 'branch_id', 'date'], 'exp_branch_idx'); t.dropColumn('branch_id'); });
  if ((await knex.schema.hasTable('recurring_expenses')) && (await knex.schema.hasColumn('recurring_expenses', 'branch_id'))) await knex.schema.alterTable('recurring_expenses', (t) => { t.dropColumn('branch_id'); });
  if (await knex.schema.hasColumn('staff_employees', 'branch_key')) await knex.schema.alterTable('staff_employees', (t) => { t.dropColumn('branch_key'); });
};
