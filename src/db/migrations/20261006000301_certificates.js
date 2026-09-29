// Sick-leave certificates, medical reports and attendance certificates with a QR code for verification.
//  • certificates: one row per issued document. The content is a snapshot taken at issue time and is never
//    edited afterwards — a correction is "revoke (with reason) + issue a new one" (replaces_id links them).
//  • serial: per clinic, per document type and per year, e.g. SL-2026-000123 (certificate_sequences).
//  • verify_code: unguessable public code printed in the QR (/verify/<code>).
exports.up = async (knex) => {
  await knex.schema.createTable('certificate_sequences', (t) => {
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('doc_type', 20).notNullable();
    t.integer('year').unsigned().notNullable();
    t.integer('last_value').unsigned().notNullable().defaultTo(0);
    t.primary(['business_id', 'doc_type', 'year']);
  });

  await knex.schema.createTable('certificates', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('doc_type', 20).notNullable();              // sick_leave | medical_report | attendance
    t.string('serial', 30).notNullable();
    t.integer('serial_year').unsigned().notNullable();
    t.integer('serial_number').unsigned().notNullable();
    t.string('verify_code', 32).notNullable().unique();
    t.string('language', 2).notNullable().defaultTo('ar');
    t.integer('appointment_id').unsigned().nullable().references('appointments.id').onDelete('SET NULL');
    t.integer('patient_id').unsigned().nullable().references('patients.id').onDelete('SET NULL');
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
    t.integer('issued_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    // Snapshots (the document must read the same years later).
    t.string('patient_name', 190).notNullable();
    t.string('patient_national_id', 40);
    t.date('patient_dob');
    t.string('patient_gender', 10);
    t.string('doctor_name', 190);
    t.string('doctor_name_en', 190);
    t.string('doctor_specialty', 190);
    t.string('doctor_specialty_en', 190);
    t.string('doctor_license', 100);
    t.string('clinic_name', 160);
    t.string('clinic_name_en', 160);
    t.date('visit_date');
    t.string('time_from', 5);                              // attendance certificate
    t.string('time_to', 5);
    t.date('leave_start');                                 // sick leave
    t.integer('leave_days').unsigned();
    t.date('leave_end');
    t.boolean('companion_leave').notNullable().defaultTo(false);
    t.string('companion_name', 190);
    t.string('companion_relation', 60);
    t.boolean('show_diagnosis').notNullable().defaultTo(false);
    t.text('diagnosis');
    t.json('body');                                        // medical report: { findings, recommendations, attachments[], addressee }
    t.string('content_hash', 64).notNullable();
    t.timestamp('issued_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('revoked_at').nullable();
    t.integer('revoked_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('revoke_reason', 500);
    t.integer('replaces_id').unsigned().nullable();
    t.unique(['business_id', 'serial']);
    t.index(['business_id', 'issued_at']);
    t.index(['business_id', 'patient_id']);
    t.index(['appointment_id']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('certificates');
  await knex.schema.dropTableIfExists('certificate_sequences');
};
