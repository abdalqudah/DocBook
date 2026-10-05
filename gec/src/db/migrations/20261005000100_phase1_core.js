// Phase 1 — accounts, roles & permissions, branches, employees, settings, media, audit log.
exports.up = async (knex) => {
  await knex.schema.createTable('settings', (t) => {
    t.string('key', 80).primary();
    t.json('value');
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.integer('updated_by').unsigned().nullable();
  });

  await knex.schema.createTable('roles', (t) => {
    t.increments('id');
    t.string('key', 60).notNullable().unique();
    t.string('name_en', 120).notNullable();
    t.string('name_ar', 120);
    t.string('description', 255);
    t.enum('data_scope', ['own', 'branch', 'all']).notNullable().defaultTo('own'); // which leads/students/applications the role sees
    t.boolean('is_system').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('role_permissions', (t) => {
    t.integer('role_id').unsigned().notNullable().references('roles.id').onDelete('CASCADE');
    t.string('permission', 80).notNullable();
    t.primary(['role_id', 'permission']);
  });

  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.enum('kind', ['staff', 'student']).notNullable();
    t.string('email', 190).notNullable();
    t.string('password_hash', 100);
    t.string('name', 160).notNullable();
    t.string('phone', 40);
    t.string('locale', 5).notNullable().defaultTo('en');
    t.enum('status', ['active', 'invited', 'disabled']).notNullable().defaultTo('active');
    t.boolean('must_change_password').notNullable().defaultTo(false);
    t.timestamp('email_verified_at').nullable();
    t.timestamp('password_changed_at').nullable();
    t.timestamp('last_login_at').nullable();
    t.integer('failed_logins').unsigned().notNullable().defaultTo(0);
    t.timestamp('locked_until').nullable();
    t.string('google_sub', 64).nullable().unique(); // prepared for Google sign-in
    t.string('microsoft_sub', 64).nullable().unique(); // prepared for Microsoft sign-in
    t.timestamps(true, true);
    t.unique(['kind', 'email']); // one staff and one student account may share an address
  });

  await knex.schema.createTable('branches', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.string('name_ar', 120);
    t.string('country', 80);
    t.string('city', 80);
    t.string('address', 255);
    t.string('phone', 40);
    t.string('email', 190);
    t.string('timezone', 60).notNullable().defaultTo('UTC');
    t.integer('manager_id').unsigned().nullable(); // employees.id (FK added below)
    t.boolean('is_active').notNullable().defaultTo(true);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('employees', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().unique().references('users.id').onDelete('CASCADE');
    t.integer('role_id').unsigned().notNullable().references('roles.id');
    t.integer('branch_id').unsigned().nullable().references('branches.id').onDelete('SET NULL');
    t.integer('manager_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.string('job_title', 120);
    t.string('department', 80);
    t.string('photo', 255);
    t.boolean('is_counsellor').notNullable().defaultTo(false);
    t.boolean('auto_assign').notNullable().defaultTo(true); // takes part in round-robin assignment
    t.json('countries'); // destination slugs this counsellor covers (assignment rules)
    t.timestamp('last_assigned_at').nullable(); // round-robin pointer
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });
  await knex.schema.alterTable('branches', (t) => { t.foreign('manager_id').references('employees.id').onDelete('SET NULL'); });

  await knex.schema.createTable('password_resets', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique();
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('login_attempts', (t) => {
    t.bigIncrements('id');
    t.string('email', 190);
    t.string('ip', 64);
    t.enum('portal', ['staff', 'student']).notNullable();
    t.boolean('success').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['email', 'created_at']);
    t.index(['ip', 'created_at']);
  });

  await knex.schema.createTable('media', (t) => {
    t.increments('id');
    t.string('purpose', 40).notNullable(); // branding, document, cms, avatar, attachment
    t.string('original_name', 255);
    t.string('mime', 100).notNullable();
    t.integer('size').unsigned().notNullable();
    t.string('storage_key', 255).notNullable().unique(); // file name inside STORAGE_DIR
    t.string('sha256', 64);
    t.boolean('is_public').notNullable().defaultTo(false);
    t.integer('uploaded_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id');
    t.integer('user_id').unsigned().nullable();
    t.string('action', 80).notNullable();
    t.string('entity_type', 40);
    t.string('entity_id', 40);
    t.text('old_values', 'mediumtext');
    t.text('new_values', 'mediumtext');
    t.string('ip', 64);
    t.string('user_agent', 255);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['entity_type', 'entity_id']);
    t.index(['user_id', 'created_at']);
    t.index(['action']);
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('branches', (t) => { t.dropForeign('manager_id'); });
  for (const t of ['audit_logs', 'media', 'login_attempts', 'password_resets', 'employees', 'branches', 'users', 'role_permissions', 'roles', 'settings']) {
    await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
  }
};
