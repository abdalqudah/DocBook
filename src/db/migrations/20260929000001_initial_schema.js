// Clinic management schema: identity, clinics (workspaces), roles & staff, audit, and every DocBook clinic
// entity — doctors, schedules, services, patients, appointments, invoices, consultations, prescriptions,
// insurance, medications, commissions, payroll adjustments, supplies and expenses.
// Every clinic record carries business_id (the clinic); services always filter by the clinic in req.ctx.

const money = (t, name) => t.decimal(name, 15, 3).notNullable().defaultTo(0);

exports.up = async (knex) => {
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name', 160).notNullable();
    t.string('email', 190).notNullable().unique();
    t.string('password_hash', 255).notNullable();
    t.boolean('must_change_password').notNullable().defaultTo(false); // temporary password set by an admin
    t.string('locale', 5).notNullable().defaultTo('ar');
    t.string('theme', 10).notNullable().defaultTo('system');
    t.string('status', 20).notNullable().defaultTo('active');
    t.string('phone', 40);
    t.boolean('is_platform_admin').notNullable().defaultTo(false);
    t.timestamp('email_verified_at').nullable();
    t.timestamp('password_changed_at').nullable();
    t.timestamp('last_login_at').nullable();
    t.integer('last_business_id').unsigned().nullable();
    t.timestamps(true, true);
  });

  // A clinic. (Internal name "business" keeps the tenancy code generic.)
  await knex.schema.createTable('businesses', (t) => {
    t.increments('id');
    t.string('name', 160).notNullable();          // clinic name (Arabic / primary)
    t.string('name_en', 160);
    t.string('slug', 40).unique();                // portal & booking address: /<slug>
    t.string('specialty', 60);
    t.string('country', 2);
    t.string('city', 100);
    t.string('currency', 3).notNullable().defaultTo('JOD');
    t.string('timezone', 64).notNullable().defaultTo('Asia/Amman');
    t.text('about');
    t.text('about_en');
    t.string('phone', 40);
    t.string('whatsapp', 40);
    t.string('email', 190);
    t.string('address', 500);
    t.string('map_url', 500);
    t.string('working_hours_text', 500);
    t.string('tax_number', 60);
    t.string('color', 9);
    t.specificType('logo', 'MEDIUMBLOB');
    t.string('logo_mime', 40);
    t.integer('logo_version').notNullable().defaultTo(0);
    t.boolean('booking_enabled').notNullable().defaultTo(true);   // public online booking page
    t.string('calendar_color_mode', 10).notNullable().defaultTo('status');
    t.integer('invoice_next_number').unsigned().notNullable().defaultTo(1);
    t.string('onboarding_step', 30);
    t.timestamp('onboarding_completed_at').nullable();
    t.string('status', 20).notNullable().defaultTo('active');
    t.integer('created_by').unsigned();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('roles', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().nullable().references('businesses.id').onDelete('CASCADE');
    t.string('key', 60).notNullable();
    t.string('name', 120).notNullable();
    t.string('description', 255);
    t.boolean('is_system').notNullable().defaultTo(false);
    t.json('permissions').notNullable();
    t.timestamps(true, true);
    t.unique(['business_id', 'key']);
  });

  await knex.schema.createTable('doctors', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('full_name', 190).notNullable();
    t.string('full_name_en', 190);
    t.string('specialization', 190);
    t.string('specialization_en', 190);
    t.text('bio');
    t.text('bio_en');
    t.text('education');
    t.text('education_en');
    t.string('phone', 40);
    t.string('whatsapp', 40);
    t.string('email', 190);
    t.string('license_number', 100);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.json('working_hours');                       // { sun: { enabled, shifts:[{start,end}], breaks:[{start,end}] }, … }
    t.integer('slot_duration_minutes').notNullable().defaultTo(30);
    money(t, 'consultation_fee');
    t.boolean('show_consultation_fee').notNullable().defaultTo(true);
    money(t, 'base_salary');
    t.string('color', 9);
    t.timestamps(true, true);
    t.index(['business_id', 'is_active']);
  });

  await knex.schema.createTable('memberships', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.integer('role_id').unsigned().notNullable().references('roles.id');
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL'); // a doctor account ↔ its doctor profile
    t.string('job_title', 100);
    t.string('status', 20).notNullable().defaultTo('active');
    t.timestamps(true, true);
    t.unique(['business_id', 'user_id']);
  });

  await knex.schema.createTable('invitations', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('email', 190).notNullable();
    t.string('name', 160);
    t.integer('role_id').unsigned().notNullable().references('roles.id');
    t.integer('doctor_id').unsigned().nullable();
    t.string('token_hash', 64).notNullable().unique();
    t.integer('invited_by').unsigned();
    t.timestamp('expires_at').notNullable();
    t.timestamp('accepted_at').nullable();
    t.timestamp('revoked_at').nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('password_resets', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique();
    t.integer('created_by').unsigned().nullable(); // set when an admin generated the link
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('email_verifications', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('email', 190).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id');
    t.integer('business_id').unsigned().nullable().index();
    t.integer('user_id').unsigned().nullable().index();
    t.string('action', 80).notNullable();
    t.string('entity_type', 60);
    t.string('entity_id', 64);
    t.json('old_values');
    t.json('new_values');
    t.string('ip', 64);
    t.string('user_agent', 255);
    t.timestamp('created_at').defaultTo(knex.fn.now()).index();
  });

  await knex.schema.createTable('notifications', (t) => {
    t.bigIncrements('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable();
    t.string('permission', 60);
    t.string('type', 40).notNullable();
    t.string('dedupe_key', 120);
    t.string('title', 255).notNullable();
    t.string('body', 1000);
    t.string('link', 255);
    t.string('severity', 12).notNullable().defaultTo('info');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['business_id', 'dedupe_key']);
  });
  await knex.schema.createTable('notification_reads', (t) => {
    t.bigInteger('notification_id').unsigned().notNullable().references('notifications.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable();
    t.timestamp('read_at').defaultTo(knex.fn.now());
    t.primary(['notification_id', 'user_id']);
  });

  // Platform-wide settings (e.g. the editable landing page content).
  await knex.schema.createTable('platform_settings', (t) => {
    t.string('key', 60).primary();
    t.specificType('value', 'MEDIUMTEXT').notNullable();
    t.timestamps(true, true);
  });

  // ------------------------------------------------------------------ scheduling
  await knex.schema.createTable('doctor_days_off', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().notNullable().references('doctors.id').onDelete('CASCADE');
    t.date('off_date').notNullable();
    t.string('reason', 255);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['doctor_id', 'off_date']);
  });

  await knex.schema.createTable('services', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL'); // null = any doctor
    t.string('name', 190).notNullable();
    t.string('name_en', 190);
    t.text('description');
    t.text('description_en');
    money(t, 'price');
    t.boolean('show_price').notNullable().defaultTo(true);
    t.integer('duration_minutes').notNullable().defaultTo(30);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.index(['business_id', 'is_active']);
  });

  await knex.schema.createTable('patients', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('full_name', 190).notNullable();
    t.string('phone', 40);
    t.string('email', 190);
    t.date('date_of_birth');
    t.string('gender', 10);
    t.string('national_id', 40);
    t.integer('insurance_provider_id').unsigned().nullable();
    t.string('insurance_number', 60);
    t.text('allergies');
    t.text('chronic_conditions');
    t.text('notes');
    t.timestamps(true, true);
    t.index(['business_id', 'phone']);
    t.index(['business_id', 'full_name']);
  });

  await knex.schema.createTable('appointments', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
    t.integer('service_id').unsigned().nullable().references('services.id').onDelete('SET NULL');
    t.integer('patient_id').unsigned().nullable().references('patients.id').onDelete('SET NULL');
    t.string('patient_name', 190).notNullable();       // snapshot, as DocBook keeps it
    t.string('patient_phone', 40);
    t.string('patient_email', 190);
    t.date('appointment_date').notNullable();
    t.string('appointment_time', 5).notNullable();     // HH:MM in the clinic's time zone
    t.integer('duration_minutes').nullable();          // custom length (else service / doctor slot)
    t.string('status', 20).notNullable().defaultTo('pending'); // pending | confirmed | completed | cancelled | no_show
    t.string('appointment_type', 20).notNullable().defaultTo('in_person'); // in_person | online | blocked
    t.string('source', 20).notNullable().defaultTo('staff'); // staff | website
    money(t, 'amount_due');
    t.string('payment_status', 20).notNullable().defaultTo('unpaid'); // unpaid | paid
    t.timestamp('paid_at').nullable();
    t.boolean('checked_in').notNullable().defaultTo(false);
    t.timestamp('arrived_at').nullable();
    t.boolean('with_doctor').notNullable().defaultTo(false);
    t.timestamp('called_at').nullable();
    t.integer('parent_appointment_id').unsigned().nullable(); // follow-ups
    t.text('notes');
    t.integer('created_by').unsigned();
    t.timestamps(true, true);
    t.index(['business_id', 'appointment_date']);
    t.index(['doctor_id', 'appointment_date']);
    t.index(['business_id', 'status']);
  });

  await knex.schema.createTable('insurance_providers', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('name', 190).notNullable();
    t.decimal('coverage_percent', 5, 2).notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('invoices', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('invoice_number').unsigned().notNullable();
    t.integer('appointment_id').unsigned().nullable();
    t.integer('doctor_id').unsigned().nullable();      // stable id for the commission engine
    t.integer('patient_id').unsigned().nullable();
    t.string('doctor_name', 190);                      // snapshots (settled invoices never change)
    t.string('service_name', 190);
    t.string('patient_name', 190).notNullable();
    t.string('patient_phone', 40);
    money(t, 'amount');                                 // amount actually charged (after discount)
    t.string('payment_method', 30).notNullable().defaultTo('cash');
    t.integer('insurance_provider_id').unsigned().nullable();
    t.string('insurance_provider_name', 190);
    t.decimal('discount_percent', 5, 2).notNullable().defaultTo(0);
    money(t, 'discount_amount');
    t.integer('created_by').unsigned();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['business_id', 'invoice_number']);
    t.index(['business_id', 'created_at']);
    t.index(['doctor_id', 'created_at']);
  });

  await knex.schema.createTable('consultations', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().notNullable().references('appointments.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().nullable();
    t.integer('patient_id').unsigned().nullable();
    t.string('patient_name', 190).notNullable();
    t.string('patient_phone', 40);
    t.json('vital_signs');                             // weightKg, heightCm, bloodPressure, temperatureC, pulseBpm, spo2
    t.integer('vitals_by').unsigned();                 // the nurse / staff member who recorded vitals
    t.text('subjective');
    t.text('objective');
    t.text('assessment');
    t.text('plan_text');
    t.text('diagnosis');
    t.timestamps(true, true);
    t.unique(['business_id', 'appointment_id']);
  });

  await knex.schema.createTable('medications', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('name', 190).notNullable();
    t.string('category', 100);
    t.string('country', 100);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('prescriptions', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().nullable();
    t.integer('doctor_id').unsigned().nullable();
    t.integer('patient_id').unsigned().nullable();
    t.string('patient_name', 190).notNullable();
    t.string('patient_phone', 40);
    t.text('diagnosis');
    t.json('items').notNullable();                     // [{ medicationName, dosage, frequency, duration, instructions }]
    t.text('notes');
    t.integer('created_by').unsigned();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'created_at']);
  });

  // ------------------------------------------------------------------ commissions & payroll (DocBook)
  await knex.schema.createTable('commission_rules', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().notNullable().references('doctors.id').onDelete('CASCADE');
    t.string('basis', 20).notNullable().defaultTo('percentage'); // percentage | fixed_per_visit | fixed_per_patient
    t.decimal('rate', 15, 4).notNullable().defaultTo(0);
    t.json('service_overrides');                       // [{ serviceName, basis, rate }]
    t.timestamps(true, true);
    t.unique(['business_id', 'doctor_id']);
  });

  await knex.schema.createTable('payroll_adjustments', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().notNullable().references('doctors.id').onDelete('CASCADE');
    t.string('type', 20).notNullable();                // bonus | deduction | advance
    money(t, 'amount');
    t.string('reason', 500).notNullable().defaultTo('');
    t.string('period', 7).notNullable();               // YYYY-MM
    t.integer('created_by').unsigned();
    t.string('approval_status', 20).notNullable().defaultTo('pending'); // pending | approved | rejected
    t.integer('approved_by').unsigned();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'doctor_id', 'period']);
  });

  await knex.schema.createTable('payroll_payments', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().notNullable().references('doctors.id').onDelete('CASCADE');
    t.string('period', 7).notNullable();
    money(t, 'base_salary');
    money(t, 'commission');
    money(t, 'bonuses');
    money(t, 'deductions');
    money(t, 'advances');
    money(t, 'net_pay');
    t.string('payment_method', 30);
    t.string('reference', 100);
    t.integer('paid_by').unsigned();
    t.timestamp('paid_at').defaultTo(knex.fn.now());
    t.unique(['doctor_id', 'period']);
  });

  // ------------------------------------------------------------------ supplies & expenses
  await knex.schema.createTable('suppliers', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('name', 190).notNullable();
    t.string('email', 190);
    t.string('phone', 40);
    t.text('notes');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('supply_items', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('supplier_id').unsigned().nullable().references('suppliers.id').onDelete('SET NULL');
    t.string('name', 190).notNullable();
    t.string('unit', 40);
    t.decimal('current_stock', 15, 2).notNullable().defaultTo(0);
    t.decimal('reorder_level', 15, 2).notNullable().defaultTo(0);
    money(t, 'unit_cost');
    t.timestamp('last_reorder_requested_at').nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('stock_movements', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('item_id').unsigned().notNullable().references('supply_items.id').onDelete('CASCADE');
    t.string('type', 10).notNullable();                // in | out | adjust
    t.decimal('quantity', 15, 2).notNullable();
    t.decimal('stock_after', 15, 2).notNullable();
    t.string('note', 255);
    t.integer('created_by').unsigned();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('expense_categories', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('key', 60).notNullable();
    t.string('name', 120).notNullable();
    t.timestamps(true, true);
    t.unique(['business_id', 'key']);
  });

  await knex.schema.createTable('expenses', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.date('date').notNullable();
    t.string('category', 60).notNullable();
    t.string('title', 255).notNullable();
    money(t, 'amount');
    t.string('payment_method', 30).notNullable().defaultTo('cash');
    t.string('invoice_number', 100);
    t.string('recorded_by', 160);
    t.integer('recorded_by_user_id').unsigned();
    t.text('notes');
    t.timestamps(true, true);
    t.index(['business_id', 'date']);
  });
};

exports.down = async (knex) => {
  const tables = ['expenses', 'expense_categories', 'stock_movements', 'supply_items', 'suppliers', 'payroll_payments', 'payroll_adjustments', 'commission_rules',
    'prescriptions', 'medications', 'consultations', 'invoices', 'insurance_providers', 'appointments', 'patients', 'services', 'doctor_days_off',
    'platform_settings', 'notification_reads', 'notifications', 'audit_logs', 'email_verifications', 'password_resets', 'invitations', 'memberships',
    'doctors', 'roles', 'businesses', 'users'];
  for (const t of tables) await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
};
