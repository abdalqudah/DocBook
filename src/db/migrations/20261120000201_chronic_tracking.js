// Chronic disease tracking (modules/chronic):
//  • patient_conditions: the chronic conditions a clinic marks on a patient (diabetes, hypertension, asthma/COPD, heart,
//    kidney, thyroid, obesity, or "other" with its own name), with the date it started and a note.
//  • patient_readings: readings entered between visits — blood pressure (systolic/diastolic), glucose (fasting /
//    random / after a meal), HbA1c, weight, height, pulse, SpO2, temperature, peak flow — on a date (and time).
//    The vital signs saved with visits (consultations.vital_signs) are read alongside them, not copied here.
//  • chronic_settings: one row per clinic — after how many days without a visit or a reading follow-up is overdue.
exports.up = async (knex) => {
  await knex.schema.createTable('patient_conditions', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
    t.string('condition_key', 20).notNullable();        // diabetes | hypertension | asthma_copd | heart | kidney | thyroid | obesity | other
    t.string('label', 120).nullable();                  // the name of an "other" condition
    t.date('started_on').nullable();
    t.string('note', 500).nullable();
    t.integer('created_by').unsigned().nullable();
    t.timestamps(true, true);
    t.index(['business_id', 'patient_id'], 'pcond_patient_idx');
    t.index(['business_id', 'condition_key'], 'pcond_key_idx');
  });
  await knex.schema.createTable('patient_readings', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
    t.string('kind', 16).notNullable();                 // bp | glucose | hba1c | weight | height | pulse | spo2 | temperature | peak_flow
    t.decimal('value', 8, 2).notNullable();             // the value (systolic for blood pressure)
    t.decimal('value2', 8, 2).nullable();               // diastolic (blood pressure only)
    t.string('context', 12).nullable();                 // glucose: fasting | random | post_meal
    t.string('unit', 12).notNullable();
    t.date('measured_on').notNullable();
    t.string('measured_time', 5).nullable();            // HH:MM, the clinic's time
    t.string('note', 500).nullable();
    t.integer('entered_by').unsigned().nullable();
    t.timestamps(true, true);
    t.index(['business_id', 'patient_id', 'kind', 'measured_on'], 'preading_patient_idx');
  });
  await knex.schema.createTable('chronic_settings', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().unique().references('businesses.id').onDelete('CASCADE');
    t.integer('overdue_days').unsigned().notNullable().defaultTo(90);
    t.integer('updated_by').unsigned().nullable();
    t.timestamps(true, true);
  });
};

exports.down = async (knex) => {
  for (const tbl of ['chronic_settings', 'patient_readings', 'patient_conditions']) {
    await knex.schema.dropTableIfExists(tbl); // eslint-disable-line no-await-in-loop
  }
};
