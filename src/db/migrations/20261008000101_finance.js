// Finance: staff (non-doctor) salaries, partners & capital, budgets.
//  • staff_employees: anyone paid a monthly salary who is not a doctor (reception, nurses, accountant, cleaners…),
//    optionally linked to a clinic membership (login); fixed monthly allowances/deductions.
//  • staff_payroll_lines: one line per employee per month (YYYY-MM), prefilled from the employee; draft until paid,
//    then locked (reopening is audited with a reason). Figures are stored so the payslip never changes afterwards.
//  • staff_payroll_adjustments: one-off bonus / deduction / advance on a month's line, with a reason.
//  • partners, partner_transactions (capital injection, withdrawal, profit share), profit_distributions (one per
//    clinic per closed month — the unique index makes "distribute" idempotent).
//  • budgets: a monthly limit per expense category or per special scope (staff salaries, doctor payroll, supplies
//    purchases); `scope_key` is 'cat:<category key>' | 'staff_salaries' | 'doctor_payroll' | 'supplies'.
const money = (t, name) => t.decimal(name, 15, 3).notNullable().defaultTo(0);

exports.up = async (knex) => {
  await knex.schema.createTable('staff_employees', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('membership_id').unsigned().nullable().references('memberships.id').onDelete('SET NULL');
    t.string('name', 190).notNullable();
    t.string('job_title', 120);
    t.string('phone', 40);
    t.string('email', 190);
    t.string('bank_name', 120);
    t.string('iban', 60);
    money(t, 'base_salary');
    money(t, 'allowances');
    money(t, 'deductions');
    t.date('hire_date').nullable();
    t.string('status', 12).notNullable().defaultTo('active'); // active | inactive
    t.text('notes');
    t.timestamps(true, true);
    t.index(['business_id', 'status'], 'stemp_status_idx');
  });
  await knex.schema.createTable('staff_payroll_lines', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('staff_employees.id').onDelete('CASCADE');
    t.string('period', 7).notNullable();
    t.string('employee_name', 190).notNullable();
    t.string('job_title', 120);
    money(t, 'base_salary');
    money(t, 'allowances');
    money(t, 'deductions');
    money(t, 'bonuses');
    money(t, 'extra_deductions');
    money(t, 'advances');
    money(t, 'net_pay');
    t.string('status', 12).notNullable().defaultTo('draft'); // draft | paid
    t.date('paid_on').nullable();
    t.string('payment_method', 30);
    t.string('reference', 100);
    t.integer('paid_by').unsigned().nullable();
    t.timestamp('paid_at').nullable();
    t.timestamp('reopened_at').nullable();
    t.integer('reopened_by').unsigned().nullable();
    t.string('reopen_reason', 500);
    t.timestamps(true, true);
    t.unique(['employee_id', 'period'], 'stpay_emp_period_uq');
    t.index(['business_id', 'period'], 'stpay_period_idx');
  });
  await knex.schema.createTable('staff_payroll_adjustments', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('line_id').unsigned().notNullable().references('staff_payroll_lines.id').onDelete('CASCADE');
    t.string('type', 20).notNullable(); // bonus | deduction | advance
    money(t, 'amount');
    t.string('reason', 500).notNullable().defaultTo('');
    t.integer('created_by').unsigned().nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['line_id'], 'stadj_line_idx');
  });
  await knex.schema.createTable('partners', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('name', 190).notNullable();
    t.string('phone', 40);
    t.string('email', 190);
    money(t, 'initial_investment');
    t.decimal('equity_percent', 7, 3).notNullable().defaultTo(0);
    t.date('joined_on').nullable();
    t.string('status', 12).notNullable().defaultTo('active'); // active | inactive
    t.text('notes');
    t.timestamps(true, true);
    t.index(['business_id', 'status'], 'partner_status_idx');
  });
  await knex.schema.createTable('profit_distributions', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('period', 7).notNullable();
    money(t, 'revenue');
    money(t, 'costs');
    t.decimal('net_profit', 15, 3).notNullable().defaultTo(0); // may be negative (a loss is shared too)
    t.integer('created_by').unsigned().nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['business_id', 'period'], 'pdist_period_uq');
  });
  await knex.schema.createTable('partner_transactions', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('partner_id').unsigned().notNullable().references('partners.id').onDelete('CASCADE');
    t.string('type', 20).notNullable(); // injection | withdrawal | profit_share
    t.decimal('amount', 15, 3).notNullable().defaultTo(0); // profit_share may be negative (loss share)
    t.date('date').notNullable();
    t.string('period', 7).nullable();
    t.integer('distribution_id').unsigned().nullable().references('profit_distributions.id').onDelete('CASCADE');
    t.decimal('equity_percent', 7, 3).nullable();
    t.string('note', 500);
    t.integer('created_by').unsigned().nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'partner_id'], 'ptx_partner_idx');
  });
  await knex.schema.createTable('budgets', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('scope_key', 80).notNullable();
    money(t, 'monthly_limit');
    t.integer('threshold_percent').unsigned().notNullable().defaultTo(80);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.unique(['business_id', 'scope_key'], 'budget_scope_uq');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('budgets');
  await knex.schema.dropTableIfExists('partner_transactions');
  await knex.schema.dropTableIfExists('profit_distributions');
  await knex.schema.dropTableIfExists('partners');
  await knex.schema.dropTableIfExists('staff_payroll_adjustments');
  await knex.schema.dropTableIfExists('staff_payroll_lines');
  await knex.schema.dropTableIfExists('staff_employees');
};
