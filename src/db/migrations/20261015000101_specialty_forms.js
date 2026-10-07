// Specialty forms for every specialty (src/modules/specialty/forms):
//  • doctors.specialty_key: the doctor's specialty from the catalogue — in a centre or a multi-specialty clinic each
//    doctor's records follow their own specialty.
//  • specialty_settings.forms_on / forms_off: forms the clinic switched on or off by hand (JSON arrays of form keys);
//    any other form follows the clinic's and its doctors' specialties.
//  • specialty_records: one filled form (a structured exam, a score, a test) for a patient, optionally from a visit.
//    `data` is the entered values (JSON), `results` what was computed from them (scores, classes), `headline` the
//    one-line summary shown in lists. Removed records are kept (voided) for the audit trail.
//  • services.code / code_system: the clinic's own procedure code for a service (CPT, CDT, the insurer's or a local
//    code) — printed with the service where codes are needed.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('doctors', 'specialty_key'))) await knex.schema.alterTable('doctors', (t) => { t.string('specialty_key', 40).nullable(); });
  if (!(await knex.schema.hasColumn('specialty_settings', 'forms_on'))) {
    await knex.schema.alterTable('specialty_settings', (t) => { t.text('forms_on').nullable(); t.text('forms_off').nullable(); });
  }
  if (!(await knex.schema.hasColumn('services', 'code'))) {
    await knex.schema.alterTable('services', (t) => { t.string('code', 40).nullable(); t.string('code_system', 20).nullable(); });
  }
  if (!(await knex.schema.hasTable('specialty_records'))) {
    await knex.schema.createTable('specialty_records', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
      t.integer('appointment_id').unsigned().nullable();
      t.integer('doctor_id').unsigned().nullable();
      t.string('form_key', 40).notNullable();
      t.integer('form_version').unsigned().notNullable().defaultTo(1);
      t.date('record_date').notNullable();
      t.text('data', 'mediumtext').notNullable();
      t.text('results').nullable();
      t.string('headline', 255).nullable();
      t.string('level', 10).nullable(); // ok | mild | warn | bad — the computed result's severity, for lists
      t.integer('created_by').unsigned().nullable();
      t.timestamp('voided_at').nullable();
      t.integer('voided_by').unsigned().nullable();
      t.string('void_reason', 255).nullable();
      t.timestamps(true, true);
      t.index(['business_id', 'patient_id', 'form_key'], 'sprec_patient_form_idx');
      t.index(['business_id', 'appointment_id'], 'sprec_appt_idx');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('specialty_records');
  if (await knex.schema.hasColumn('services', 'code')) await knex.schema.alterTable('services', (t) => { t.dropColumn('code'); t.dropColumn('code_system'); });
  if (await knex.schema.hasColumn('specialty_settings', 'forms_on')) await knex.schema.alterTable('specialty_settings', (t) => { t.dropColumn('forms_on'); t.dropColumn('forms_off'); });
  if (await knex.schema.hasColumn('doctors', 'specialty_key')) await knex.schema.alterTable('doctors', (t) => { t.dropColumn('specialty_key'); });
};
