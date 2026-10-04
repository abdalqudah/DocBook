// Medical centre: shared staff and shared expenses, split between the centre's practices.
//   centers.split_mode           how a new shared expense is split by default: equal | percent
//   businesses.center_percent    a practice's share (percent mode), set by the centre's admin
//   center_staff                 people working for the whole centre (reception, cashier, cleaner…): salary, login
//   center_expenses              a shared cost (rent, electricity, shared salaries…) and how it was split
//   center_expense_shares        what each practice owes for it; paying it records an expense in that practice
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('centers', 'split_mode'))) await knex.schema.alterTable('centers', (t) => { t.string('split_mode', 10).notNullable().defaultTo('equal'); });
  if (!(await knex.schema.hasColumn('businesses', 'center_percent'))) await knex.schema.alterTable('businesses', (t) => { t.decimal('center_percent', 6, 2).nullable(); });
  if (!(await knex.schema.hasTable('center_staff'))) {
    await knex.schema.createTable('center_staff', (t) => {
      t.increments('id');
      t.integer('center_id').unsigned().notNullable().references('centers.id').onDelete('CASCADE');
      t.string('name', 160).notNullable();
      t.string('job_title', 120).nullable();
      t.string('phone', 40).nullable();
      t.decimal('salary_monthly', 12, 3).notNullable().defaultTo(0);
      t.integer('user_id').unsigned().nullable(); // a login in the centre admin's account (shared reception / cash)
      t.boolean('is_active').notNullable().defaultTo(true);
      t.timestamps(true, true);
      t.index(['center_id', 'is_active']);
    });
  }
  if (!(await knex.schema.hasTable('center_expenses'))) {
    await knex.schema.createTable('center_expenses', (t) => {
      t.increments('id');
      t.integer('center_id').unsigned().notNullable().references('centers.id').onDelete('CASCADE');
      t.date('date').notNullable();
      t.string('title', 190).notNullable();
      t.string('category', 40).notNullable().defaultTo('miscellaneous');
      t.decimal('amount', 12, 3).notNullable();
      t.string('split_mode', 10).notNullable(); // equal | percent | custom
      t.string('period', 7).nullable(); // YYYY-MM for a month's shared salaries (one per month)
      t.text('note').nullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamps(true, true);
      t.index(['center_id', 'date']);
    });
  }
  if (!(await knex.schema.hasTable('center_expense_shares'))) {
    await knex.schema.createTable('center_expense_shares', (t) => {
      t.increments('id');
      t.integer('expense_id').unsigned().notNullable().references('center_expenses.id').onDelete('CASCADE');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.decimal('amount', 12, 3).notNullable();
      t.timestamp('paid_at').nullable();
      t.integer('paid_by').unsigned().nullable();
      t.integer('practice_expense_id').unsigned().nullable(); // the expense recorded in the practice when paid
      t.unique(['expense_id', 'business_id']);
      t.index(['business_id', 'paid_at']);
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('center_expense_shares');
  await knex.schema.dropTableIfExists('center_expenses');
  await knex.schema.dropTableIfExists('center_staff');
  if (await knex.schema.hasColumn('businesses', 'center_percent')) await knex.schema.alterTable('businesses', (t) => { t.dropColumn('center_percent'); });
  if (await knex.schema.hasColumn('centers', 'split_mode')) await knex.schema.alterTable('centers', (t) => { t.dropColumn('split_mode'); });
};
