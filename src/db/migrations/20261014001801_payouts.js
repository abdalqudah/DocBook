// Money that repeats and money that leaves:
//   recurring_expenses — rent, phone, internet… (monthly / quarterly / yearly / weekly), recorded automatically or
//                        after a confirmation on their date
//   bank_templates     — the clinic's own layout of a salary transfer file for each bank it uses (any bank: columns,
//                        order, labels, CSV or Excel, the bank's e-mail), with bank_transfers logging each file made
//   doctors' bank details, and when each payslip was sent
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('recurring_expenses'))) {
    await knex.schema.createTable('recurring_expenses', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('title', 255).notNullable();
      t.string('category', 80).notNullable();
      t.decimal('amount', 15, 3).notNullable();
      t.string('payment_method', 20).notNullable().defaultTo('bank_transfer');
      t.string('every', 10).notNullable().defaultTo('month'); // week | month | quarter | year
      t.integer('day_of_month').unsigned().nullable();
      t.date('next_date').notNullable();
      t.date('end_date').nullable();
      t.string('mode', 10).notNullable().defaultTo('confirm'); // auto | confirm
      t.boolean('is_active').notNullable().defaultTo(true);
      t.text('notes').nullable();
      t.date('last_posted').nullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamps(true, true);
      t.index(['business_id', 'next_date']);
    });
  }
  if (!(await knex.schema.hasTable('bank_templates'))) {
    await knex.schema.createTable('bank_templates', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('name', 120).notNullable();
      t.string('match', 500).nullable(); // other spellings of the bank name in the staff / doctor records
      t.string('email', 190).nullable();
      t.string('format', 6).notNullable().defaultTo('csv'); // csv | xlsx
      t.string('delimiter', 4).notNullable().defaultTo(',');
      t.boolean('header').notNullable().defaultTo(true);
      t.text('columns').notNullable(); // JSON [{ field, label, value }]
      t.integer('decimals').unsigned().notNullable().defaultTo(3);
      t.string('date_format', 12).notNullable().defaultTo('YYYY-MM-DD');
      t.string('debit_iban', 60).nullable();
      t.string('debit_name', 190).nullable();
      t.boolean('is_default').notNullable().defaultTo(false);
      t.timestamps(true, true);
    });
  }
  if (!(await knex.schema.hasTable('bank_transfers'))) {
    await knex.schema.createTable('bank_transfers', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('template_id').unsigned().nullable().references('bank_templates.id').onDelete('SET NULL');
      t.string('bank_name', 120).nullable();
      t.string('period', 7).notNullable();
      t.integer('payees').unsigned().notNullable();
      t.decimal('total', 15, 3).notNullable();
      t.string('action', 10).notNullable(); // download | email
      t.string('sent_to', 190).nullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
  }
  const add = async (table, col, fn) => { if (!(await knex.schema.hasColumn(table, col))) await knex.schema.alterTable(table, fn); };
  await add('doctors', 'bank_name', (t) => { t.string('bank_name', 120).nullable(); });
  await add('doctors', 'iban', (t) => { t.string('iban', 60).nullable(); });
  await add('staff_payroll_lines', 'slip_sent_at', (t) => { t.timestamp('slip_sent_at').nullable(); t.string('slip_sent_to', 190).nullable(); });
  await add('payroll_payments', 'slip_sent_at', (t) => { t.timestamp('slip_sent_at').nullable(); t.string('slip_sent_to', 190).nullable(); });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('bank_transfers');
  await knex.schema.dropTableIfExists('bank_templates');
  await knex.schema.dropTableIfExists('recurring_expenses');
  const drop = async (table, cols) => { for (const c of cols) if (await knex.schema.hasColumn(table, c)) await knex.schema.alterTable(table, (t) => t.dropColumn(c)); }; // eslint-disable-line no-await-in-loop
  await drop('doctors', ['bank_name', 'iban']);
  await drop('staff_payroll_lines', ['slip_sent_at', 'slip_sent_to']);
  await drop('payroll_payments', ['slip_sent_at', 'slip_sent_to']);
};
