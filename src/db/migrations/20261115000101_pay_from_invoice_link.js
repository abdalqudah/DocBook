// A card payment started from the invoice's own link (the clinic's e-mail, no sign-in): it returns to that link.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('platform_payments', 'via_link'))) await knex.schema.alterTable('platform_payments', (t) => { t.boolean('via_link').notNullable().defaultTo(false); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('platform_payments', 'via_link')) await knex.schema.alterTable('platform_payments', (t) => { t.dropColumn('via_link'); });
};
