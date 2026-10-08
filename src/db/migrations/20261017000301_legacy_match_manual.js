// Legacy Patient Recovery: whether an import also checks the old patients against patients entered here by hand
// (off for a first migration into a clinic without patients; on by default when the clinic already has its own),
// and how many of the source's attachment links ended up as files attached to a patient.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('import_jobs', 'match_manual'))) await knex.schema.alterTable('import_jobs', (t) => { t.boolean('match_manual').notNullable().defaultTo(false); });
  // Attachment links of the source (patients JSON) reconciled apart from the files: files actually attached to a patient.
  if (!(await knex.schema.hasColumn('import_jobs', 'sys_links'))) await knex.schema.alterTable('import_jobs', (t) => { t.integer('sys_links').unsigned().nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('import_jobs', 'sys_links')) await knex.schema.alterTable('import_jobs', (t) => { t.dropColumn('sys_links'); });
  if (await knex.schema.hasColumn('import_jobs', 'match_manual')) await knex.schema.alterTable('import_jobs', (t) => { t.dropColumn('match_manual'); });
};
