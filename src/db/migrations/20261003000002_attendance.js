// Staff attendance (clock in / clock out) for clinics.
//  • attendance_records: one row per shift of one staff member — clock_in, then clock_out when they leave.
//    Times are server time (UTC). work_date is the clinic's date of the clock-in (clinic time zone).
//    in_method / out_method: 'button' (own page) or 'qr' (scanned at the attendance screen);
//    'manual' when a manager added or corrected the record (reason required, audited).
//  • attendance_settings: per-clinic option "clock in/out only by scanning the QR code".
exports.up = async (knex) => {
  await knex.schema.createTable('attendance_records', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.date('work_date').notNullable();
    t.datetime('clock_in').notNullable();
    t.datetime('clock_out').nullable();
    t.string('in_method', 10).notNullable().defaultTo('button');
    t.string('out_method', 10).nullable();
    t.string('in_ip', 64).nullable();
    t.string('in_user_agent', 255).nullable();
    t.string('out_ip', 64).nullable();
    t.string('out_user_agent', 255).nullable();
    t.string('correction_reason', 500).nullable();
    t.integer('corrected_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('corrected_at').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'work_date']);
    t.index(['business_id', 'user_id', 'clock_out']);
  });
  await knex.schema.createTable('attendance_settings', (t) => {
    t.integer('business_id').unsigned().primary().references('businesses.id').onDelete('CASCADE');
    t.boolean('qr_only').notNullable().defaultTo(false);
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('attendance_settings');
  await knex.schema.dropTableIfExists('attendance_records');
};
