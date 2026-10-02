// Each clinic's own connections (Website → Connections): social profiles, Google / Bing site verification, its Google
// Business Profile and review link, and its measurement pixels. Stored as JSON on the clinic; applied to the clinic's
// public pages at once (no publishing needed). Pixels load only after the visitor accepts on that clinic's cookie notice.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('businesses', 'marketing'))) await knex.schema.alterTable('businesses', (t) => { t.text('marketing').nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('businesses', 'marketing')) await knex.schema.alterTable('businesses', (t) => { t.dropColumn('marketing'); });
};
