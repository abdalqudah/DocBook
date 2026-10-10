// A clinic with branches: each branch closes its own cash drawer. cash_closings.branch_scope is the branch the closing
// was made in ('' = the whole clinic, 'main' = the main branch, or a branch id) — its period and expected cash are that
// branch's only.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('cash_closings', 'branch_scope'))) {
    await knex.schema.alterTable('cash_closings', (t) => { t.string('branch_scope', 12).notNullable().defaultTo(''); t.index(['business_id', 'branch_scope', 'period_end'], 'cclose_scope_idx'); });
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('cash_closings', 'branch_scope')) {
    await knex.schema.alterTable('cash_closings', (t) => { t.dropIndex(['business_id', 'branch_scope', 'period_end'], 'cclose_scope_idx'); t.dropColumn('branch_scope'); });
  }
};
