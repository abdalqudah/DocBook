// Phase 5 — appointments (types, availability, bookings), courses (sessions, registrations, attendance,
// certificates) and events (registrations with QR tickets and check-in).
exports.up = async (knex) => {
  await knex.schema.createTable('appointment_types', (t) => {
    t.increments('id');
    t.string('slug', 140).notNullable().unique();
    t.string('name_en', 120).notNullable(); t.string('name_ar', 120);
    t.text('description_en'); t.text('description_ar');
    t.integer('duration_min').unsigned().notNullable().defaultTo(30);
    t.integer('buffer_min').unsigned().notNullable().defaultTo(10);
    t.enum('location_mode', ['online', 'in_person', 'both']).notNullable().defaultTo('both');
    t.string('location_text', 255);
    t.integer('capacity').unsigned().notNullable().defaultTo(1);
    t.integer('min_notice_hours').unsigned().notNullable().defaultTo(12);
    t.integer('max_days_ahead').unsigned().notNullable().defaultTo(45);
    t.integer('price').unsigned().nullable(); t.string('currency', 3);
    t.boolean('is_public').notNullable().defaultTo(true);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });
  await knex.schema.createTable('appointment_type_staff', (t) => {
    t.integer('type_id').unsigned().notNullable().references('appointment_types.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.primary(['type_id', 'employee_id']);
  });
  await knex.schema.createTable('availability', (t) => {
    t.increments('id');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.tinyint('weekday').unsigned().notNullable(); // 0 = Sunday
    t.string('start_time', 5).notNullable(); t.string('end_time', 5).notNullable(); // HH:MM in the employee's branch time zone
    t.index(['employee_id', 'weekday']);
  });
  await knex.schema.createTable('availability_exceptions', (t) => {
    t.increments('id');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.date('date').notNullable();
    t.boolean('is_off').notNullable().defaultTo(true);
    t.string('start_time', 5); t.string('end_time', 5); // custom hours when not off
    t.string('note', 190);
    t.index(['employee_id', 'date']);
  });
  await knex.schema.createTable('appointments', (t) => {
    t.increments('id');
    t.string('ref', 12).notNullable().unique();
    t.integer('type_id').unsigned().notNullable().references('appointment_types.id');
    t.integer('employee_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('SET NULL');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('SET NULL');
    t.datetime('start_at').notNullable(); t.datetime('end_at').notNullable();
    t.enum('status', ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show', 'rescheduled']).notNullable().defaultTo('scheduled');
    t.enum('mode', ['online', 'in_person']).notNullable().defaultTo('online');
    t.string('location', 255); t.string('meeting_url', 500);
    t.string('contact_name', 160); t.string('contact_email', 190); t.string('contact_phone', 40);
    t.text('notes');
    t.enum('booked_via', ['website', 'portal', 'staff']).notNullable().defaultTo('staff');
    t.string('manage_token', 40).unique(); // public cancel / reschedule link
    t.integer('rescheduled_from_id').unsigned().nullable();
    t.string('cancel_reason', 255);
    t.timestamp('reminder_sent_at').nullable();
    t.integer('branch_id').unsigned().nullable().references('branches.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['employee_id', 'start_at']); t.index(['start_at', 'status']);
  });

  const seo = (t) => { t.string('seo_title_en', 160); t.string('seo_title_ar', 160); t.string('seo_description_en', 300); t.string('seo_description_ar', 300); };
  await knex.schema.createTable('courses', (t) => {
    t.increments('id');
    t.string('slug', 140).notNullable().unique();
    t.string('name_en', 190).notNullable(); t.string('name_ar', 190);
    t.text('description_en'); t.text('description_ar');
    t.integer('instructor_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.string('instructor_name', 160);
    t.string('image', 500);
    t.enum('mode', ['online', 'in_person', 'blended']).notNullable().defaultTo('in_person');
    t.string('location', 255);
    t.date('start_date').nullable(); t.date('end_date').nullable();
    t.string('schedule_en', 255); t.string('schedule_ar', 255);
    t.integer('capacity').unsigned().nullable();
    t.integer('price').unsigned().nullable(); t.string('currency', 3).notNullable().defaultTo('USD');
    t.boolean('cancellable').notNullable().defaultTo(true);
    t.boolean('registration_open').notNullable().defaultTo(true);
    t.boolean('certificate').notNullable().defaultTo(true);
    t.boolean('is_active').notNullable().defaultTo(true);
    seo(t);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });
  await knex.schema.createTable('course_sessions', (t) => {
    t.increments('id');
    t.integer('course_id').unsigned().notNullable().references('courses.id').onDelete('CASCADE');
    t.datetime('starts_at').notNullable(); t.datetime('ends_at').nullable();
    t.string('topic', 190);
  });
  await knex.schema.createTable('course_registrations', (t) => {
    t.increments('id');
    t.string('ref', 12).notNullable().unique();
    t.integer('course_id').unsigned().notNullable().references('courses.id').onDelete('CASCADE');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('SET NULL');
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('SET NULL');
    t.string('name', 160).notNullable(); t.string('email', 190); t.string('phone', 40);
    t.enum('status', ['pending', 'confirmed', 'waitlist', 'cancelled', 'completed']).notNullable().defaultTo('pending');
    t.enum('payment_status', ['free', 'unpaid', 'paid', 'refunded']).notNullable().defaultTo('unpaid');
    t.integer('amount').unsigned().nullable(); t.string('currency', 3);
    t.string('certificate_no', 30).unique(); t.timestamp('certificate_issued_at').nullable();
    t.string('manage_token', 40).unique();
    t.timestamps(true, true);
    t.index(['course_id', 'status']);
  });
  await knex.schema.createTable('course_attendance', (t) => {
    t.integer('session_id').unsigned().notNullable().references('course_sessions.id').onDelete('CASCADE');
    t.integer('registration_id').unsigned().notNullable().references('course_registrations.id').onDelete('CASCADE');
    t.boolean('present').notNullable().defaultTo(true);
    t.primary(['session_id', 'registration_id']);
  });

  await knex.schema.createTable('events', (t) => {
    t.increments('id');
    t.string('slug', 140).notNullable().unique();
    t.string('title_en', 190).notNullable(); t.string('title_ar', 190);
    t.enum('type', ['fair', 'webinar', 'open_day', 'info_session', 'workshop', 'other']).notNullable().defaultTo('info_session');
    t.text('description_en'); t.text('description_ar');
    t.string('image', 500);
    t.datetime('starts_at').notNullable(); t.datetime('ends_at').nullable();
    t.boolean('is_virtual').notNullable().defaultTo(false);
    t.string('location_en', 255); t.string('location_ar', 255);
    t.string('meeting_url', 500); // sent to registrants only
    t.integer('capacity').unsigned().nullable();
    t.boolean('registration_open').notNullable().defaultTo(true);
    t.json('speakers_en'); t.json('speakers_ar');
    t.boolean('is_active').notNullable().defaultTo(true);
    seo(t);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['starts_at']);
  });
  await knex.schema.createTable('event_registrations', (t) => {
    t.increments('id');
    t.integer('event_id').unsigned().notNullable().references('events.id').onDelete('CASCADE');
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('SET NULL');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('SET NULL');
    t.string('name', 160).notNullable(); t.string('email', 190); t.string('phone', 40);
    t.string('ticket_token', 40).notNullable().unique();
    t.enum('status', ['registered', 'waitlist', 'cancelled', 'attended']).notNullable().defaultTo('registered');
    t.timestamp('checked_in_at').nullable(); t.integer('checked_in_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('reminder_sent_at').nullable(); t.timestamp('follow_up_sent_at').nullable();
    t.timestamps(true, true);
    t.unique(['event_id', 'email']);
  });
};

exports.down = async (knex) => {
  for (const t of ['event_registrations', 'events', 'course_attendance', 'course_registrations', 'course_sessions', 'courses', 'appointments', 'availability_exceptions', 'availability', 'appointment_type_staff', 'appointment_types']) await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
};
