// Legacy Patient Recovery: how an old patient was matched to a patient here (match_by: legacy_id | legacy_number |
// file_number | phone — or ambiguous when two old patients point at the same patient), and the old mobile number,
// kept on the import item so the matching can be run again without reading the source file.
exports.up = async (knex) => {
  const add = async (name, fn) => { if (!(await knex.schema.hasColumn('import_items', name))) await knex.schema.alterTable('import_items', fn); };
  await add('match_by', (t) => { t.string('match_by', 16).nullable(); });
  await add('mobile', (t) => { t.string('mobile', 60).nullable(); });
};
exports.down = async (knex) => {
  for (const c of ['mobile', 'match_by']) { // eslint-disable-line no-restricted-syntax
    if (await knex.schema.hasColumn('import_items', c)) await knex.schema.alterTable('import_items', (t) => { t.dropColumn(c); }); // eslint-disable-line no-await-in-loop
  }
};
