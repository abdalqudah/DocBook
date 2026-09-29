// Settings → Your database: a one-way copy of a clinic's data into its own MySQL/MariaDB or PostgreSQL
// database. Connection (password encrypted), chosen datasets, schedule, one-copy-at-a-time lock and a run log.
exports.up = async (knex) => {
  await knex.schema.createTable('clinic_data_sync', (t) => {
    t.integer('business_id').unsigned().primary().references('businesses.id').onDelete('CASCADE');
    t.string('driver', 10).notNullable().defaultTo('mysql'); // mysql | postgres
    t.string('host', 190).notNullable();
    t.integer('port').unsigned().notNullable();
    t.string('database_name', 64).notNullable();
    t.string('username', 64).notNullable();
    t.text('password_enc').nullable(); // src/core/secrets (AES-256-GCM)
    t.boolean('ssl').notNullable().defaultTo(true);
    t.string('table_prefix', 16).notNullable().defaultTo('db_');
    t.json('datasets');
    t.string('frequency', 10).notNullable().defaultTo('daily'); // manual | hourly | daily
    t.boolean('enabled').notNullable().defaultTo(true);
    t.datetime('next_run_at').nullable();
    t.datetime('running_since').nullable();
    t.datetime('last_run_at').nullable();
    t.string('last_status', 10).nullable(); // ok | failed
    t.text('last_error').nullable();
    t.datetime('verified_at').nullable();
    t.integer('updated_by').unsigned().nullable();
    t.timestamps(true, true);
    t.index(['enabled', 'next_run_at'], 'cds_due_idx');
  });
  await knex.schema.createTable('data_sync_runs', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('trigger', 10).notNullable(); // manual | schedule
    t.string('status', 10).notNullable(); // running | ok | failed
    t.json('counts');
    t.text('error').nullable();
    t.integer('duration_ms').unsigned().nullable();
    t.integer('started_by').unsigned().nullable();
    t.datetime('started_at').notNullable();
    t.datetime('finished_at').nullable();
    t.index(['business_id', 'started_at'], 'dsr_business_idx');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('data_sync_runs');
  await knex.schema.dropTableIfExists('clinic_data_sync');
};
