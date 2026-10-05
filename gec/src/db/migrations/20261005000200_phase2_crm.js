// Phase 2 — CRM: lead pipeline, leads, students, notes, activities (one timeline), tasks.
exports.up = async (knex) => {
  await knex.schema.createTable('lead_stages', (t) => {
    t.increments('id');
    t.string('key', 40).notNullable().unique();
    t.string('name_en', 80).notNullable();
    t.string('name_ar', 80);
    t.integer('position').notNullable().defaultTo(0);
    t.string('tone', 12).notNullable().defaultTo('info'); // chip colour: info, brand, warn, ok, bad
    t.boolean('is_won').notNullable().defaultTo(false); // reaching it closes the lead as converted
    t.boolean('is_lost').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
  });

  await knex.schema.createTable('lead_sources', (t) => {
    t.string('key', 40).primary();
    t.string('name_en', 80).notNullable();
    t.string('name_ar', 80);
    t.boolean('is_system').notNullable().defaultTo(true);
  });

  const person = (t) => {
    t.string('ref', 12).notNullable().unique();
    t.string('first_name', 80).notNullable();
    t.string('last_name', 80);
    t.string('email', 190);
    t.string('phone', 40);
    t.string('phone_tail', 12); // last 9 digits, for duplicate detection
    t.string('whatsapp', 40);
    t.string('nationality', 80);
    t.string('residence_country', 80);
    t.string('city', 80);
    t.integer('counsellor_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.integer('branch_id').unsigned().nullable().references('branches.id').onDelete('SET NULL');
    t.string('preferred_locale', 5).notNullable().defaultTo('en');
    t.boolean('consent_contact').notNullable().defaultTo(false);
    t.boolean('consent_marketing').notNullable().defaultTo(false);
    t.timestamp('consent_marketing_at').nullable();
    t.timestamp('unsubscribed_at').nullable();
    // attribution (first touch is kept; latest touch updated on each new conversion)
    t.string('source', 40);
    t.string('source_detail', 190);
    t.string('utm_source', 120); t.string('utm_medium', 120); t.string('utm_campaign', 160); t.string('utm_term', 160); t.string('utm_content', 160);
    t.string('landing_page', 500); t.string('referrer', 500);
    t.string('latest_source', 40); t.string('latest_utm_source', 120); t.string('latest_utm_medium', 120); t.string('latest_utm_campaign', 160);
    t.string('visitor_id', 40);
    t.timestamp('first_visit_at').nullable(); t.timestamp('last_visit_at').nullable();
    t.timestamp('last_activity_at').nullable();
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['email']); t.index(['phone_tail']); t.index(['counsellor_id']); t.index(['branch_id']); t.index(['visitor_id']);
  };

  await knex.schema.createTable('students', (t) => {
    t.increments('id');
    person(t);
    t.integer('user_id').unsigned().nullable().unique().references('users.id').onDelete('SET NULL'); // portal account
    t.date('date_of_birth').nullable();
    t.enum('gender', ['female', 'male', 'other', 'undisclosed']).nullable();
    t.text('passport_enc'); // encrypted passport number
    t.string('passport_hash', 64).nullable().index(); // keyed hash, for duplicate detection only
    t.string('passport_last4', 4);
    t.date('passport_expiry').nullable();
    // academic
    t.string('education_level', 40); t.string('institution', 160); t.string('major', 120);
    t.decimal('gpa', 5, 2).nullable(); t.decimal('gpa_scale', 5, 2).nullable(); t.date('graduation_date').nullable();
    // english tests
    t.decimal('ielts_overall', 3, 1).nullable(); t.decimal('ielts_min_band', 3, 1).nullable();
    t.integer('toefl').nullable(); t.integer('pte').nullable(); t.integer('duolingo').nullable(); t.date('english_test_date').nullable();
    // preferences
    t.json('pref_countries'); t.json('pref_fields'); t.string('pref_degree', 30); t.integer('budget_usd').nullable(); t.string('pref_intake', 40);
    t.boolean('work_after_study').notNullable().defaultTo(false);
    // history
    t.boolean('visa_refused').notNullable().defaultTo(false); t.text('visa_history'); t.decimal('work_experience_years', 4, 1).nullable(); t.text('profile_notes');
    t.enum('journey_stage', ['profile', 'counselling', 'program_selection', 'documents', 'application', 'offer', 'visa', 'pre_departure', 'enrolled']).notNullable().defaultTo('profile');
    t.enum('status', ['active', 'on_hold', 'enrolled', 'closed']).notNullable().defaultTo('active');
    t.integer('merged_into_id').unsigned().nullable();
  });

  await knex.schema.createTable('leads', (t) => {
    t.increments('id');
    person(t);
    t.integer('stage_id').unsigned().notNullable().references('lead_stages.id');
    t.timestamp('stage_entered_at').notNullable().defaultTo(knex.fn.now());
    t.enum('status', ['open', 'converted', 'lost', 'merged']).notNullable().defaultTo('open');
    t.string('lost_reason', 190);
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('SET NULL');
    t.integer('merged_into_id').unsigned().nullable();
    // what they asked about
    t.string('interest_degree', 30); t.string('interest_field', 120); t.json('interest_countries'); t.string('interest_intake', 40);
    t.string('budget_range', 60); t.string('education_level', 40); t.string('english_level', 60); t.text('message');
    t.string('interest_type', 30); // general, program, university, scholarship, course, event, visa, download
    t.string('interest_ref', 190); // the program / university / scholarship they asked about
    // scoring and follow-up
    t.integer('score').notNullable().defaultTo(0);
    t.enum('temperature', ['cold', 'warm', 'hot']).notNullable().defaultTo('cold');
    t.timestamp('first_contacted_at').nullable();
    t.timestamp('next_follow_up_at').nullable();
    t.index(['stage_id', 'status']);
    t.index(['status', 'created_at']);
  });

  await knex.schema.createTable('notes', (t) => {
    t.increments('id');
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('CASCADE');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('CASCADE');
    t.integer('application_id').unsigned().nullable(); // FK added with applications (phase 4)
    t.text('body').notNullable();
    t.boolean('is_shareable').notNullable().defaultTo(false); // visible to the student in the portal
    t.json('mentions'); // employee ids
    t.integer('author_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('activities', (t) => {
    t.bigIncrements('id');
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('CASCADE');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('CASCADE');
    t.integer('application_id').unsigned().nullable();
    t.string('type', 30).notNullable(); // call, email, sms, whatsapp, meeting, note, stage, assigned, task, document, application, payment, appointment, web, form, system
    t.string('title', 255).notNullable();
    t.text('body');
    t.json('meta');
    t.integer('note_id').unsigned().nullable().references('notes.id').onDelete('CASCADE');
    t.integer('actor_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.boolean('is_shareable').notNullable().defaultTo(false);
    t.timestamp('occurred_at').notNullable().defaultTo(knex.fn.now());
    t.index(['lead_id', 'occurred_at']);
    t.index(['student_id', 'occurred_at']);
    t.index(['type', 'occurred_at']);
  });

  await knex.schema.createTable('tasks', (t) => {
    t.increments('id');
    t.string('title', 190).notNullable();
    t.text('description');
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('CASCADE');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('CASCADE');
    t.integer('application_id').unsigned().nullable();
    t.integer('assignee_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('due_at').nullable();
    t.enum('priority', ['low', 'normal', 'high', 'urgent']).notNullable().defaultTo('normal');
    t.enum('status', ['todo', 'in_progress', 'waiting', 'completed']).notNullable().defaultTo('todo');
    t.timestamp('completed_at').nullable();
    t.enum('recurrence', ['none', 'daily', 'weekly', 'monthly', 'every_n_days']).notNullable().defaultTo('none');
    t.integer('recurrence_days').unsigned().nullable();
    t.integer('previous_id').unsigned().nullable(); // the occurrence this one follows
    t.string('origin', 40); // manual, automation:<id>, system
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['assignee_id', 'status', 'due_at']);
  });
};

exports.down = async (knex) => {
  for (const t of ['tasks', 'activities', 'notes', 'leads', 'students', 'lead_sources', 'lead_stages']) await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
};
