// Legacy Patient Recovery: which doctor here each doctor name of the old system (Clinica) is — chosen by the clinic on
// the import's "Doctors" page (an existing doctor, a new doctor with that name, or none); name_key '' is "treatments
// with no doctor". The old calendar comes in as appointments marked external_source = 'clinica' (external_uid holds
// the old key, unique per clinic, so it is filled once).
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('legacy_doctor_map'))) {
    await knex.schema.createTable('legacy_doctor_map', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('legacy_source', 20).notNullable().defaultTo('clinica');
      t.string('name_key', 190).notNullable();
      t.string('name', 190).nullable();
      t.string('action', 10).notNullable().defaultTo('doctor'); // doctor | create | none
      t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
      t.timestamps(true, true);
      t.unique(['business_id', 'legacy_source', 'name_key'], { indexName: 'ldocmap_uq' });
    });
  }
  if (!(await knex.schema.hasColumn('legacy_treatments', 'appointment_id'))) {
    await knex.schema.alterTable('legacy_treatments', (t) => { t.integer('appointment_id').unsigned().nullable(); });
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('legacy_treatments', 'appointment_id')) await knex.schema.alterTable('legacy_treatments', (t) => { t.dropColumn('appointment_id'); });
  await knex.schema.dropTableIfExists('legacy_doctor_map');
};
