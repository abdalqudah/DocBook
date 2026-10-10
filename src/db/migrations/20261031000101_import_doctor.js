// Clinica's chairs (Clinic 1…5) are rooms, not doctors: the doctors rotate between them. An appointment brought from
// Clinica keeps the doctor written on its calendar row (import_doctor), and import_doctor_auto says its doctor was
// set by the import (worked out again when better information comes) — never once a person chose the doctor.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('appointments', 'import_doctor'))) {
    await knex.schema.alterTable('appointments', (t) => { t.string('import_doctor', 190).nullable(); t.boolean('import_doctor_auto').notNullable().defaultTo(false); });
    await knex('appointments').where({ external_source: 'clinica' }).update({ import_doctor_auto: true });
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('appointments', 'import_doctor')) await knex.schema.alterTable('appointments', (t) => { t.dropColumn('import_doctor'); t.dropColumn('import_doctor_auto'); });
};
