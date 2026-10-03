// Surgeries: a doctor's time block marked as an operation — which patient, what procedure, at which hospital — listed
// under Patients → Surgeries, with the hospital told by e-mail or WhatsApp. The block (appointments, type 'blocked')
// keeps the doctor's time; date, time and length are copied here so a cancelled surgery stays in the list.
exports.up = async (knex) => {
  if (await knex.schema.hasTable('surgeries')) return;
  await knex.schema.createTable('surgeries', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().nullable().unique().references('appointments.id').onDelete('SET NULL');
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
    t.integer('patient_id').unsigned().nullable().references('patients.id').onDelete('SET NULL');
    t.string('patient_name', 190).notNullable();
    t.string('patient_phone', 40).nullable();
    t.date('surgery_date').notNullable();
    t.string('surgery_time', 5).notNullable();
    t.integer('duration_minutes').unsigned().nullable();
    t.string('procedure_name', 190).notNullable();
    t.integer('hospital_id').unsigned().nullable().references('clinic_partners.id').onDelete('SET NULL');
    t.string('hospital_name', 190).nullable();
    t.text('notes').nullable();
    t.string('status', 12).notNullable().defaultTo('scheduled'); // scheduled | done | cancelled
    t.timestamp('sent_at').nullable();
    t.string('sent_to', 190).nullable();
    t.string('sent_channel', 12).nullable();
    t.integer('created_by').unsigned().nullable();
    t.timestamps(true, true);
    t.index(['business_id', 'surgery_date']);
  });
};

exports.down = async (knex) => { await knex.schema.dropTableIfExists('surgeries'); };
