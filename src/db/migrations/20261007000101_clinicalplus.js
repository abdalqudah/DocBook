// Clinical extras: ICD-10 coded diagnoses, the consultation timer and medical-record privacy.
//  • icd_custom_codes: a clinic's own diagnosis codes (added to the bundled WHO ICD-10 list in search).
//  • consultation_diagnoses: coded diagnoses attached to a visit (one primary + secondary ones). The title is a
//    snapshot (Arabic and English) so the record reads the same if the code list changes later.
//  • consultation_timers: one row per visit — when the doctor started and finished the consultation, with pauses.
//  • businesses.clinical_privacy: "Only the treating doctor can open clinical notes".
//  • record_access_log: one row per page view of a patient's clinical record or a visit (who / when / what).
//  • record_access_grants: "emergency access" (break-glass) — a staff member's time-limited access to one
//    patient's record, with the mandatory reason.
exports.up = async (knex) => {
  await knex.schema.alterTable('businesses', (t) => {
    t.boolean('clinical_privacy').notNullable().defaultTo(false);
  });

  await knex.schema.createTable('icd_custom_codes', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('code', 20).notNullable();
    t.string('title_ar', 255).notNullable();
    t.string('title_en', 255);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().nullable();
    t.timestamps(true, true);
    t.unique(['business_id', 'code']);
  });

  await knex.schema.createTable('consultation_diagnoses', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().notNullable().references('appointments.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().nullable();
    t.integer('doctor_id').unsigned().nullable();
    t.string('code', 20).notNullable();
    t.string('title_ar', 255);
    t.string('title_en', 255);
    t.boolean('is_primary').notNullable().defaultTo(false);
    t.boolean('is_custom').notNullable().defaultTo(false);
    t.integer('created_by').unsigned().nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['appointment_id', 'code']);
    t.index(['business_id', 'code']);
    t.index(['business_id', 'patient_id']);
  });

  await knex.schema.createTable('consultation_timers', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().notNullable().unique().references('appointments.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().nullable();
    t.timestamp('started_at').notNullable();
    t.integer('started_by').unsigned().nullable();
    t.timestamp('paused_at').nullable();
    t.integer('paused_seconds').unsigned().notNullable().defaultTo(0);
    t.timestamp('ended_at').nullable();
    t.integer('ended_by').unsigned().nullable();
    t.index(['business_id', 'doctor_id']);
  });

  await knex.schema.createTable('record_access_log', (t) => {
    t.bigIncrements('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable();
    t.integer('patient_id').unsigned().nullable();
    t.integer('appointment_id').unsigned().nullable();
    t.string('what', 20).notNullable();    // patient | visit | break_glass
    t.string('access', 12).notNullable();  // full | limited | emergency
    t.string('ip', 64);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['business_id', 'created_at']);
    t.index(['business_id', 'patient_id', 'created_at']);
    t.index(['business_id', 'user_id', 'created_at']);
  });

  await knex.schema.createTable('record_access_grants', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable();
    t.string('reason', 500).notNullable();
    t.timestamp('expires_at').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['business_id', 'patient_id', 'user_id']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('record_access_grants');
  await knex.schema.dropTableIfExists('record_access_log');
  await knex.schema.dropTableIfExists('consultation_timers');
  await knex.schema.dropTableIfExists('consultation_diagnoses');
  await knex.schema.dropTableIfExists('icd_custom_codes');
  await knex.schema.alterTable('businesses', (t) => { t.dropColumn('clinical_privacy'); });
};
