// Staff leave (/app/leave): staff ask for leave from their own account, managers (leave.manage) approve or reject.
//  • staff_leave_requests: one request per period (from → to, or a half day), kind annual / sick / unpaid / other,
//    pending → approved | rejected | cancelled. `days` = the clinic's working days in the period (closed weekdays
//    are skipped), stored when the request is made.
//  • staff_leave_settings: the clinic's yearly allowance (annual and sick days, 14 each by default).
//  • staff_leave_allowances: a staff member's own yearly allowance when it differs from the clinic's.
//  • staff_payroll_adjustments.source: 'leave' on a deduction added from unpaid leave (one per salary line).
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('staff_leave_requests'))) {
    await knex.schema.createTable('staff_leave_requests', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
      t.string('kind', 20).notNullable();
      t.date('from_date').notNullable();
      t.date('to_date').notNullable();
      t.boolean('half_day').notNullable().defaultTo(false);
      t.decimal('days', 5, 1).notNullable().defaultTo(0);
      t.string('reason', 500).nullable();
      t.string('status', 20).notNullable().defaultTo('pending');
      t.integer('decided_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
      t.datetime('decided_at').nullable();
      t.string('decision_note', 500).nullable();
      t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['business_id', 'user_id', 'from_date']);
      t.index(['business_id', 'status']);
      t.index(['business_id', 'from_date', 'to_date']);
    });
  }
  if (!(await knex.schema.hasTable('staff_leave_settings'))) {
    await knex.schema.createTable('staff_leave_settings', (t) => {
      t.integer('business_id').unsigned().notNullable().primary().references('businesses.id').onDelete('CASCADE');
      t.decimal('annual_days', 5, 1).notNullable().defaultTo(14);
      t.decimal('sick_days', 5, 1).notNullable().defaultTo(14);
      t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }
  if (!(await knex.schema.hasTable('staff_leave_allowances'))) {
    await knex.schema.createTable('staff_leave_allowances', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
      t.decimal('annual_days', 5, 1).nullable();
      t.decimal('sick_days', 5, 1).nullable();
      t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.unique(['business_id', 'user_id']);
    });
  }
  if (!(await knex.schema.hasColumn('staff_payroll_adjustments', 'source'))) {
    await knex.schema.alterTable('staff_payroll_adjustments', (t) => { t.string('source', 40).nullable(); });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('staff_payroll_adjustments', 'source')) {
    await knex.schema.alterTable('staff_payroll_adjustments', (t) => { t.dropColumn('source'); });
  }
  await knex.schema.dropTableIfExists('staff_leave_allowances');
  await knex.schema.dropTableIfExists('staff_leave_settings');
  await knex.schema.dropTableIfExists('staff_leave_requests');
};
