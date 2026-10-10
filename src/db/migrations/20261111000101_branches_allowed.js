// Branches are off on the platform and in a medical centre: a clinic that wants another branch adds a new clinic with
// its own subscription. The platform admin may allow branches for a clinic (businesses.branches_allowed); a clinic
// that already runs branches keeps them.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('businesses', 'branches_allowed'))) {
    await knex.schema.alterTable('businesses', (t) => { t.boolean('branches_allowed').notNullable().defaultTo(false); });
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('businesses', 'branches_allowed')) await knex.schema.alterTable('businesses', (t) => { t.dropColumn('branches_allowed'); });
};
