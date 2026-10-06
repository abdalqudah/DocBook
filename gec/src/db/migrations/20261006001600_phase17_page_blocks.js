// Phase 17 — website editor: content blocks on pages (the page builder).
exports.up = async (knex) => {
  await knex.schema.alterTable('pages', (t) => { t.json('blocks'); });
};
exports.down = async (knex) => {
  await knex.schema.alterTable('pages', (t) => { t.dropColumn('blocks'); });
};
