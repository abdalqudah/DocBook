// Medical centre: the account made when a centre signs up is the centre's administration — not a clinic. It runs the
// centre (doctors' practices, shared reception, cash screen, staff and costs) and sees none of a clinic's pages.
//   businesses.kind   'clinic' (default) | 'center_admin'
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('businesses', 'kind'))) {
    await knex.schema.alterTable('businesses', (t) => { t.string('kind', 20).notNullable().defaultTo('clinic'); });
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('businesses', 'kind')) await knex.schema.alterTable('businesses', (t) => { t.dropColumn('kind'); });
};
