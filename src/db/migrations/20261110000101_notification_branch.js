// Notifications about a visit belong to the visit's branch (notifications.branch_key: 'main' or a branch id; null =
// the whole clinic), so each branch sees its own.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('notifications', 'branch_key'))) {
    await knex.schema.alterTable('notifications', (t) => { t.string('branch_key', 20).nullable(); });
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('notifications', 'branch_key')) await knex.schema.alterTable('notifications', (t) => { t.dropColumn('branch_key'); });
};
