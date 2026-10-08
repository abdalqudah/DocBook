// Legacy Patient Recovery → the patient's own file: each Clinica treatment becomes an item of the patient's treatment
// plan (dental_plan_items: tooth, procedure, price, planned / done with its date, the doctor), linked both ways so the
// conversion runs once per treatment (and again safely); doctors of the old system are created here by name.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('legacy_treatments', 'plan_item_id'))) {
    await knex.schema.alterTable('legacy_treatments', (t) => { t.integer('plan_item_id').unsigned().nullable(); t.integer('doctor_id').unsigned().nullable(); });
  }
  if (!(await knex.schema.hasColumn('dental_plan_items', 'legacy_treatment_id'))) {
    await knex.schema.alterTable('dental_plan_items', (t) => { t.integer('legacy_treatment_id').unsigned().nullable(); t.unique(['legacy_treatment_id'], 'dplan_legacy_uq'); });
  }
  if (!(await knex.schema.hasColumn('doctors', 'legacy_source'))) {
    await knex.schema.alterTable('doctors', (t) => { t.string('legacy_source', 20).nullable(); }); // set on doctors created from an import
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('doctors', 'legacy_source')) await knex.schema.alterTable('doctors', (t) => { t.dropColumn('legacy_source'); });
  if (await knex.schema.hasColumn('dental_plan_items', 'legacy_treatment_id')) await knex.schema.alterTable('dental_plan_items', (t) => { t.dropUnique(['legacy_treatment_id'], 'dplan_legacy_uq'); t.dropColumn('legacy_treatment_id'); });
  if (await knex.schema.hasColumn('legacy_treatments', 'plan_item_id')) await knex.schema.alterTable('legacy_treatments', (t) => { t.dropColumn('plan_item_id'); t.dropColumn('doctor_id'); });
};
