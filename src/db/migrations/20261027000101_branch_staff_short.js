// Branches, part two: each staff member can belong to a branch (memberships.work_branch: '' every branch, 'main', or a
// branch id — a member tied to a branch works there only), and each branch has a short name for the top bar
// (clinic_branches.short_name; the main branch's in businesses.branch_short).
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('memberships', 'work_branch'))) await knex.schema.alterTable('memberships', (t) => { t.string('work_branch', 12).notNullable().defaultTo(''); });
  if (!(await knex.schema.hasColumn('clinic_branches', 'short_name'))) await knex.schema.alterTable('clinic_branches', (t) => { t.string('short_name', 40).nullable(); });
  if (!(await knex.schema.hasColumn('businesses', 'branch_short'))) await knex.schema.alterTable('businesses', (t) => { t.string('branch_short', 40).nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('memberships', 'work_branch')) await knex.schema.alterTable('memberships', (t) => { t.dropColumn('work_branch'); });
  if (await knex.schema.hasColumn('clinic_branches', 'short_name')) await knex.schema.alterTable('clinic_branches', (t) => { t.dropColumn('short_name'); });
  if (await knex.schema.hasColumn('businesses', 'branch_short')) await knex.schema.alterTable('businesses', (t) => { t.dropColumn('branch_short'); });
};
