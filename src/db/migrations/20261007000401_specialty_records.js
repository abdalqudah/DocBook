// Specialty clinical records (shown by the clinic's specialty, switchable per clinic):
//  • specialty_settings: one row per clinic — each module on/off (NULL = automatic from businesses.specialty) and the
//    clinic's editable antenatal schedule template (JSON; NULL = the built-in general guide).
//  • dental_entries: odontogram history. Every change to a tooth is a dated entry (FDI tooth number, surfaces, condition,
//    material), optionally linked to the visit it was recorded in and the treating doctor. Removing an entry voids it
//    (kept for the history/audit), the chart is rebuilt from the non-void entries.
//  • dental_plan_items: treatment plan (planned → done / cancelled) with an optional service and price.
//  • growth_measurements: weight / length-height / head circumference of a child on a date (WHO 0–5 y z-scores computed on read).
//  • pregnancies, antenatal_visits, pregnancy_checks: pregnancy follow-up (dating, EDD, outcome), the antenatal visit log and
//    which checks of the clinic's schedule were done.
exports.up = async (knex) => {
  await knex.schema.createTable('specialty_settings', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.boolean('dental_enabled').nullable();
    t.boolean('growth_enabled').nullable();
    t.boolean('pregnancy_enabled').nullable();
    t.text('pregnancy_schedule').nullable();
    t.integer('updated_by').unsigned().nullable();
    t.timestamps(true, true);
    t.unique(['business_id'], 'spset_business_uq');
  });
  await knex.schema.createTable('dental_entries', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
    t.smallint('tooth').notNullable();                 // FDI: 11–48 permanent, 51–85 primary
    t.string('surfaces', 20).nullable();               // comma list of M,D,O,B,L (O = occlusal/incisal, B = buccal/facial, L = lingual/palatal)
    t.string('condition', 20).notNullable();
    t.string('material', 20).nullable();
    t.date('entry_date').notNullable();
    t.text('notes').nullable();
    t.integer('appointment_id').unsigned().nullable().references('appointments.id').onDelete('SET NULL');
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable();
    t.timestamp('voided_at').nullable();
    t.integer('voided_by').unsigned().nullable();
    t.timestamps(true, true);
    t.index(['business_id', 'patient_id'], 'dent_patient_idx');
  });
  await knex.schema.createTable('dental_plan_items', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
    t.smallint('tooth').nullable();
    t.string('surfaces', 20).nullable();
    t.string('procedure_name', 190).notNullable();
    t.integer('service_id').unsigned().nullable().references('services.id').onDelete('SET NULL');
    t.decimal('price', 15, 3).nullable();
    t.string('status', 12).notNullable().defaultTo('planned'); // planned | done | cancelled
    t.date('done_on').nullable();
    t.integer('appointment_id').unsigned().nullable().references('appointments.id').onDelete('SET NULL');
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
    t.text('notes').nullable();
    t.integer('created_by').unsigned().nullable();
    t.timestamps(true, true);
    t.index(['business_id', 'patient_id', 'status'], 'dplan_patient_idx');
  });
  await knex.schema.createTable('growth_measurements', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
    t.date('measured_on').notNullable();
    t.decimal('weight_kg', 6, 3).nullable();
    t.decimal('length_cm', 5, 1).nullable();
    t.string('position', 8).nullable();                // lying | standing (how length/height was measured)
    t.decimal('head_cm', 5, 1).nullable();
    t.text('notes').nullable();
    t.integer('appointment_id').unsigned().nullable().references('appointments.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable();
    t.timestamps(true, true);
    t.index(['business_id', 'patient_id', 'measured_on'], 'growth_patient_idx');
  });
  await knex.schema.createTable('pregnancies', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
    t.string('status', 10).notNullable().defaultTo('active'); // active | closed
    t.string('dating_method', 6).notNullable().defaultTo('lmp'); // lmp | scan
    t.date('lmp').nullable();
    t.date('scan_date').nullable();
    t.smallint('scan_ga_days').nullable();
    t.date('edd').notNullable();
    t.smallint('gravida').nullable();
    t.smallint('para').nullable();
    t.string('blood_group', 3).nullable();              // A | B | AB | O
    t.string('rh', 4).nullable();                       // pos | neg
    t.string('risk_flags', 400).nullable();             // comma list of keys
    t.text('notes').nullable();
    t.string('outcome', 16).nullable();                 // live_birth | stillbirth | miscarriage | ectopic | termination | other
    t.date('outcome_date').nullable();
    t.string('delivery_mode', 16).nullable();           // vaginal | assisted | caesarean
    t.decimal('baby_weight_kg', 6, 3).nullable();
    t.text('outcome_notes').nullable();
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable();
    t.timestamp('closed_at').nullable();
    t.timestamps(true, true);
    t.index(['business_id', 'patient_id', 'status'], 'preg_patient_idx');
  });
  await knex.schema.createTable('antenatal_visits', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('pregnancy_id').unsigned().notNullable().references('pregnancies.id').onDelete('CASCADE');
    t.date('visit_date').notNullable();
    t.decimal('weight_kg', 6, 2).nullable();
    t.string('bp', 7).nullable();
    t.decimal('fundal_height_cm', 4, 1).nullable();
    t.smallint('fhr').nullable();
    t.string('presentation', 12).nullable();            // cephalic | breech | transverse | unknown
    t.string('oedema', 10).nullable();                  // none | mild | moderate | severe
    t.string('urine_protein', 6).nullable();            // neg | trace | 1+ | 2+ | 3+
    t.string('urine_glucose', 6).nullable();
    t.text('notes').nullable();
    t.integer('appointment_id').unsigned().nullable().references('appointments.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable();
    t.timestamps(true, true);
    t.index(['business_id', 'pregnancy_id'], 'anc_preg_idx');
  });
  await knex.schema.createTable('pregnancy_checks', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('pregnancy_id').unsigned().notNullable().references('pregnancies.id').onDelete('CASCADE');
    t.string('check_key', 40).notNullable();
    t.date('done_on').notNullable();
    t.string('notes', 255).nullable();
    t.integer('created_by').unsigned().nullable();
    t.timestamps(true, true);
    t.unique(['pregnancy_id', 'check_key'], 'pcheck_uq');
  });
};

exports.down = async (knex) => {
  for (const tbl of ['pregnancy_checks', 'antenatal_visits', 'pregnancies', 'growth_measurements', 'dental_plan_items', 'dental_entries', 'specialty_settings']) {
    await knex.schema.dropTableIfExists(tbl); // eslint-disable-line no-await-in-loop
  }
};
