// A quotation's own title ("Pro plan for Al Noor Clinic"), shown with its number; numbers may be edited (unique).
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('quotes', 'title'))) await knex.schema.alterTable('quotes', (t) => { t.string('title', 200).nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('quotes', 'title')) await knex.schema.alterTable('quotes', (t) => { t.dropColumn('title'); });
};
