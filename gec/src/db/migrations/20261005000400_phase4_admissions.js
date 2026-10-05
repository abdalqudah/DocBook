// Phase 4 — admissions: configurable application stages, applications + stage history, documents, visa cases.
exports.up = async (knex) => {
  await knex.schema.createTable('application_stages', (t) => {
    t.increments('id');
    t.string('key', 40).notNullable().unique();
    t.string('name_en', 80).notNullable(); t.string('name_ar', 80);
    t.integer('position').notNullable().defaultTo(0);
    t.string('tone', 12).notNullable().defaultTo('info');
    t.string('journey', 30); // student journey stage this application stage corresponds to
    t.string('lead_stage', 40); // lead pipeline stage the linked lead moves to (forward only)
    t.integer('sla_days').unsigned().nullable(); // "stuck" after this many days in the stage
    t.boolean('is_terminal').notNullable().defaultTo(false); // closes the application
    t.boolean('is_success').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
  });

  await knex.schema.createTable('applications', (t) => {
    t.increments('id');
    t.string('ref', 12).notNullable().unique();
    t.integer('student_id').unsigned().notNullable().references('students.id').onDelete('CASCADE');
    t.integer('program_id').unsigned().nullable().references('programs.id').onDelete('SET NULL');
    t.integer('university_id').unsigned().nullable().references('universities.id').onDelete('SET NULL');
    t.string('program_name', 190); // snapshot / programs not in the catalogue
    t.string('university_name', 190);
    t.string('intake', 7); // YYYY-MM
    t.integer('stage_id').unsigned().notNullable().references('application_stages.id');
    t.timestamp('stage_entered_at').notNullable().defaultTo(knex.fn.now());
    t.enum('status', ['open', 'won', 'lost', 'withdrawn']).notNullable().defaultTo('open');
    t.string('closed_reason', 190);
    t.integer('counsellor_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.integer('branch_id').unsigned().nullable().references('branches.id').onDelete('SET NULL');
    t.enum('priority', ['normal', 'high']).notNullable().defaultTo('normal');
    t.date('deadline').nullable();
    t.string('next_action', 255); t.date('next_action_due').nullable();
    t.timestamp('submitted_at').nullable();
    t.string('university_ref', 80); // applicant / student id at the university
    t.string('portal_url', 500);
    t.enum('offer_type', ['none', 'conditional', 'unconditional', 'rejected']).notNullable().defaultTo('none');
    t.text('offer_conditions');
    t.timestamp('offer_received_at').nullable();
    t.integer('deposit_amount').nullable(); t.string('deposit_currency', 3); t.date('deposit_due').nullable(); t.timestamp('deposit_paid_at').nullable();
    t.string('cas_number', 80); // CAS / COE / I-20 number
    t.integer('tuition_fee').nullable(); t.string('currency', 3);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['stage_id', 'status']); t.index(['counsellor_id']); t.index(['student_id']);
  });

  await knex.schema.createTable('application_stage_history', (t) => {
    t.bigIncrements('id');
    t.integer('application_id').unsigned().notNullable().references('applications.id').onDelete('CASCADE');
    t.integer('from_stage_id').unsigned().nullable().references('application_stages.id').onDelete('SET NULL');
    t.integer('to_stage_id').unsigned().notNullable().references('application_stages.id');
    t.integer('changed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('seconds_in_previous').unsigned().nullable();
    t.string('note', 500);
    t.timestamp('changed_at').defaultTo(knex.fn.now());
    t.index(['application_id', 'changed_at']);
  });

  await knex.schema.createTable('document_types', (t) => {
    t.string('key', 40).primary();
    t.string('name_en', 120).notNullable(); t.string('name_ar', 120);
    t.enum('category', ['identity', 'academic', 'english', 'application', 'financial', 'visa', 'other']).notNullable().defaultTo('other');
    t.boolean('has_expiry').notNullable().defaultTo(false);
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
  });

  await knex.schema.createTable('visa_cases', (t) => {
    t.increments('id');
    t.string('ref', 12).notNullable().unique();
    t.integer('student_id').unsigned().notNullable().references('students.id').onDelete('CASCADE');
    t.integer('application_id').unsigned().nullable().references('applications.id').onDelete('SET NULL');
    t.string('country_code', 2).notNullable();
    t.string('visa_type', 120);
    t.enum('stage', ['preparing', 'documents_pending', 'ready', 'submitted', 'biometrics', 'interview', 'processing', 'approved', 'refused', 'withdrawn']).notNullable().defaultTo('preparing');
    t.timestamp('stage_entered_at').notNullable().defaultTo(knex.fn.now());
    t.string('application_number', 80);
    t.date('submitted_on').nullable(); t.datetime('biometrics_at').nullable(); t.datetime('interview_at').nullable();
    t.enum('medical', ['not_required', 'required', 'done']).notNullable().defaultTo('not_required'); t.date('medical_on').nullable();
    t.date('decision_on').nullable(); t.text('refusal_reason');
    t.date('travel_date').nullable(); t.date('visa_expiry').nullable();
    t.integer('officer_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.integer('counsellor_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.integer('branch_id').unsigned().nullable().references('branches.id').onDelete('SET NULL');
    t.text('notes');
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['stage']); t.index(['student_id']);
  });

  await knex.schema.createTable('documents', (t) => {
    t.increments('id');
    t.integer('student_id').unsigned().notNullable().references('students.id').onDelete('CASCADE');
    t.integer('application_id').unsigned().nullable().references('applications.id').onDelete('SET NULL');
    t.integer('visa_case_id').unsigned().nullable().references('visa_cases.id').onDelete('SET NULL');
    t.string('type_key', 40).notNullable().references('document_types.key');
    t.string('title', 190);
    t.integer('media_id').unsigned().nullable().references('media.id').onDelete('SET NULL');
    t.enum('status', ['missing', 'uploaded', 'under_review', 'approved', 'rejected', 'expired']).notNullable().defaultTo('missing');
    t.date('expiry_date').nullable();
    t.timestamp('requested_at').nullable(); t.integer('requested_by').unsigned().nullable().references('users.id').onDelete('SET NULL'); t.date('due_date').nullable();
    t.timestamp('uploaded_at').nullable(); t.integer('uploaded_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('reviewed_at').nullable(); t.integer('reviewed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('rejection_reason', 500);
    t.text('notes');
    t.integer('version').unsigned().notNullable().defaultTo(0);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['student_id', 'status']); t.index(['status', 'uploaded_at']);
  });

  // Links added now that the tables exist.
  await knex.schema.alterTable('notes', (t) => { t.foreign('application_id').references('applications.id').onDelete('CASCADE'); });
  await knex.schema.alterTable('activities', (t) => { t.foreign('application_id').references('applications.id').onDelete('SET NULL'); });
  await knex.schema.alterTable('tasks', (t) => { t.foreign('application_id').references('applications.id').onDelete('CASCADE'); });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('tasks', (t) => { t.dropForeign('application_id'); });
  await knex.schema.alterTable('activities', (t) => { t.dropForeign('application_id'); });
  await knex.schema.alterTable('notes', (t) => { t.dropForeign('application_id'); });
  for (const t of ['documents', 'visa_cases', 'document_types', 'application_stage_history', 'applications', 'application_stages']) await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
};
