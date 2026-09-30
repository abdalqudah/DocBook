// Staff attendance, round 2: door screens with their own secret link, working hours (late / absent) and a
// "same network" rule for QR scans. Additive only — existing attendance_records / attendance_settings rows stay.
//  • attendance_kiosks: a tablet / PC at the clinic door. It opens the full-screen QR page with a secret link
//    (/kiosk/<token>), so the device at the door is never signed in with a staff account. The token is stored
//    hashed (lookup) and encrypted (so a manager can open the screen again); "new link" replaces both.
//  • attendance_settings: the clinic's default working hours (days + start/end), minutes of grace before a
//    clock-in counts as late, and "accept scans only from the clinic network".
//  • attendance_schedules: a staff member's own working hours when they differ from the clinic's
//    ({ sat: { start, end }, … } — days not listed are days off).
//  • attendance_records.off_network: the scan came from another network than the door screen.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('attendance_kiosks'))) {
    await knex.schema.createTable('attendance_kiosks', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('name', 120).notNullable();
      t.text('display_token_enc').notNullable();
      t.string('display_token_hash', 64).notNullable().unique();
      t.boolean('is_active').notNullable().defaultTo(true);
      t.string('last_ip', 64).nullable();
      t.datetime('last_seen_at').nullable();
      t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['business_id']);
    });
  }
  if (!(await knex.schema.hasTable('attendance_schedules'))) {
    await knex.schema.createTable('attendance_schedules', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
      t.text('days').notNullable();
      t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.unique(['business_id', 'user_id']);
    });
  }
  const add = async (table, col, fn) => { if (!(await knex.schema.hasColumn(table, col))) await knex.schema.alterTable(table, fn); };
  await add('attendance_settings', 'work_days', (t) => { t.string('work_days', 40).nullable(); });
  await add('attendance_settings', 'work_start', (t) => { t.string('work_start', 5).nullable(); });
  await add('attendance_settings', 'work_end', (t) => { t.string('work_end', 5).nullable(); });
  await add('attendance_settings', 'late_grace_minutes', (t) => { t.integer('late_grace_minutes').notNullable().defaultTo(15); });
  await add('attendance_settings', 'same_network', (t) => { t.boolean('same_network').notNullable().defaultTo(false); });
  await add('attendance_records', 'off_network', (t) => { t.boolean('off_network').notNullable().defaultTo(false); });
};

exports.down = async (knex) => {
  const drop = async (table, col) => { if (await knex.schema.hasColumn(table, col)) await knex.schema.alterTable(table, (t) => { t.dropColumn(col); }); };
  await drop('attendance_records', 'off_network');
  for (const c of ['same_network', 'late_grace_minutes', 'work_end', 'work_start', 'work_days']) await drop('attendance_settings', c); // eslint-disable-line no-await-in-loop
  await knex.schema.dropTableIfExists('attendance_schedules');
  await knex.schema.dropTableIfExists('attendance_kiosks');
};
