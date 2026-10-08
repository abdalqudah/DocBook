// Legacy Patient Recovery: which branch of the clinic the Clinica data belongs to — chosen per patient group of the old
// system (e.g. "Abdali Hospital" → the Abdali branch) on the import's "Doctors" page. Visits the import makes for the
// patients of that group are on that branch; otherwise on the doctor's branch (NULL = the main branch).
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('legacy_branch_map'))) {
    await knex.schema.createTable('legacy_branch_map', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('legacy_source', 20).notNullable().defaultTo('clinica');
      t.string('group_key', 190).notNullable();
      t.string('group_name', 190).nullable();
      t.integer('branch_id').unsigned().nullable().references('clinic_branches.id').onDelete('SET NULL');
      t.timestamps(true, true);
      t.unique(['business_id', 'legacy_source', 'group_key'], { indexName: 'lbranchmap_uq' });
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('legacy_branch_map');
};
