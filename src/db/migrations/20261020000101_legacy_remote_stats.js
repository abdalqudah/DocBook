// Direct pull from Clinica (legacy remote): what a pull did beyond files — patients added / filled, treatments added,
// calendar days read and appointments added / merged — and its calendar range, kept with the job as JSON.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('import_jobs', 'stats'))) await knex.schema.alterTable('import_jobs', (t) => { t.text('stats').nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('import_jobs', 'stats')) await knex.schema.alterTable('import_jobs', (t) => { t.dropColumn('stats'); });
};
