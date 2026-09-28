// Initial schema: identity, workspaces (businesses), roles, audit, and every DocBook business entity.
// Money columns are DECIMAL(15,3) so 3-decimal currencies (JOD, KWD, BHD, OMR) stay exact.
// Every business record carries business_id; services always filter by the tenant from req.ctx.

const money = (t, name) => t.decimal(name, 15, 3).notNullable().defaultTo(0);

exports.up = async (knex) => {
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name', 160).notNullable();
    t.string('email', 190).notNullable().unique();
    t.string('password_hash', 255).notNullable();
    t.string('locale', 5).notNullable().defaultTo('en');
    t.string('theme', 10).notNullable().defaultTo('system');
    t.string('status', 20).notNullable().defaultTo('active');
    t.string('phone', 40);
    t.timestamp('email_verified_at').nullable();
    t.timestamp('password_changed_at').nullable();
    t.timestamp('last_login_at').nullable();
    t.integer('last_business_id').unsigned().nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('businesses', (t) => {
    t.increments('id');
    t.string('name', 160).notNullable();
    t.string('legal_name', 190);
    t.string('industry', 60);
    t.string('country', 2);
    t.string('currency', 3).notNullable().defaultTo('USD');
    t.string('tax_number', 60);
    t.string('phone', 40);
    t.string('email', 190);
    t.string('address', 500);
    t.string('website', 190);
    t.string('color', 9);                         // workspace accent (Settings → Appearance)
    t.specificType('logo', 'MEDIUMBLOB');         // stored in the database: survives redeploys
    t.string('logo_mime', 40);
    t.integer('logo_version').notNullable().defaultTo(0);
    t.decimal('default_delivery_fee', 15, 3).notNullable().defaultTo(0);
    t.string('invoice_prefix', 20).notNullable().defaultTo('ORD-');
    t.integer('invoice_next_number').unsigned().notNullable().defaultTo(1000);
    t.string('onboarding_step', 30);
    t.timestamp('onboarding_completed_at').nullable();
    t.integer('created_by').unsigned();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('roles', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().nullable().references('businesses.id').onDelete('CASCADE'); // null = system template
    t.string('key', 60).notNullable();
    t.string('name', 120).notNullable();
    t.string('description', 255);
    t.boolean('is_system').notNullable().defaultTo(false);
    t.json('permissions').notNullable();
    t.timestamps(true, true);
    t.unique(['business_id', 'key']);
  });

  await knex.schema.createTable('memberships', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.integer('role_id').unsigned().notNullable().references('roles.id');
    t.string('status', 20).notNullable().defaultTo('active');
    t.integer('partner_id').unsigned().nullable(); // a "partner viewer" account can be linked to its partner record
    t.timestamps(true, true);
    t.unique(['business_id', 'user_id']);
  });

  await knex.schema.createTable('invitations', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('email', 190).notNullable();
    t.integer('role_id').unsigned().notNullable().references('roles.id');
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
    t.integer('user_id').unsigned().nullable();   // null = everyone who may see `permission`
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

  // ------------------------------------------------------------------ business data (DocBook)
  await knex.schema.createTable('partners', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('name', 160).notNullable();
    t.string('phone', 40);
    t.string('email', 190);
    money(t, 'initial_investment');
    money(t, 'additional_contributions');   // maintained from partner_transactions
    money(t, 'total_withdrawn');            // maintained from partner_transactions
    t.decimal('current_equity_percent', 6, 2).notNullable().defaultTo(0);
    t.date('join_date');
    t.text('notes');
    t.string('color', 9);
    t.string('status', 20).notNullable().defaultTo('active');
    t.string('legacy_id', 64);
    t.timestamps(true, true);
    t.index(['business_id']);
  });

  await knex.schema.createTable('partner_transactions', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('partner_id').unsigned().notNullable().references('partners.id').onDelete('CASCADE');
    t.string('type', 20).notNullable();      // contribution | withdrawal | opening
    money(t, 'amount');
    t.date('date').notNullable();
    t.string('reference', 100);
    t.string('note', 500);
    t.integer('distribution_id').unsigned().nullable();
    t.integer('created_by').unsigned();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'partner_id']);
  });

  await knex.schema.createTable('profit_distributions', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('period', 7).notNullable();     // YYYY-MM, or 'all'
    money(t, 'revenue');
    money(t, 'gross_profit');
    money(t, 'net_profit');
    t.string('status', 20).notNullable().defaultTo('recorded'); // recorded | paid
    t.string('note', 500);
    t.integer('created_by').unsigned();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'period']);
  });
  await knex.schema.createTable('profit_distribution_lines', (t) => {
    t.increments('id');
    t.integer('distribution_id').unsigned().notNullable().references('profit_distributions.id').onDelete('CASCADE');
    t.integer('partner_id').unsigned().notNullable();
    t.string('partner_name', 160).notNullable();
    t.decimal('equity_percent', 6, 2).notNullable().defaultTo(0);
    money(t, 'allocated_profit');
    money(t, 'withdrawn');
    money(t, 'net_payable');
    money(t, 'paid_out');
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
    t.string('legacy_id', 64);
    t.timestamps(true, true);
    t.index(['business_id', 'date']);
    t.index(['business_id', 'category']);
  });

  await knex.schema.createTable('employees', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('name', 160).notNullable();
    t.string('role', 100);
    t.string('phone', 40);
    t.string('email', 190);
    money(t, 'base_salary');
    t.string('commission_type', 30).notNullable().defaultTo('percentage'); // percentage | fixed_per_order
    t.decimal('commission_rate', 15, 3).notNullable().defaultTo(0);
    money(t, 'deductions');     // deductions & advances (DocBook merges both)
    money(t, 'bonus');
    t.date('hire_date');
    t.string('status', 20).notNullable().defaultTo('active'); // active | on_leave | inactive
    t.string('bank_account', 100);
    t.text('notes');
    t.json('paid_months');            // ["2026-09", …] — drives salary expense (DocBook semantics)
    t.json('region_commission_rates');// { "<region>": rate }
    t.string('legacy_id', 64);
    t.timestamps(true, true);
    t.index(['business_id']);
  });

  await knex.schema.createTable('payroll_payments', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.string('month', 7).notNullable();
    money(t, 'base_salary');
    money(t, 'bonus');
    money(t, 'deductions');
    money(t, 'commission');
    money(t, 'net_pay');
    t.string('payment_method', 30);
    t.string('reference', 100);
    t.integer('paid_by').unsigned();
    t.timestamp('paid_at').defaultTo(knex.fn.now());
    t.unique(['employee_id', 'month']);
  });

  await knex.schema.createTable('purchases', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.date('date').notNullable();
    t.string('supplier_name', 160).notNullable();
    t.string('supplier_phone', 40);
    t.string('item_name', 190).notNullable();
    t.string('sku', 100);
    t.string('category', 100);
    t.decimal('unit_cost', 15, 3).notNullable().defaultTo(0);
    t.decimal('quantity', 15, 3).notNullable().defaultTo(0);
    money(t, 'total_cost');
    money(t, 'shipping_cost');
    money(t, 'paid_amount');
    t.string('payment_status', 20).notNullable().defaultTo('due'); // paid | partial | due
    t.string('invoice_ref', 100);
    t.text('notes');
    t.string('legacy_id', 64);
    t.timestamps(true, true);
    t.index(['business_id', 'date']);
  });

  await knex.schema.createTable('campaigns', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('campaign_name', 190).notNullable();
    t.string('platform', 30).notNullable();
    t.date('start_date');
    t.date('end_date');
    money(t, 'cost');
    t.bigInteger('impressions').notNullable().defaultTo(0);
    t.bigInteger('clicks').notNullable().defaultTo(0);
    t.bigInteger('conversions').notNullable().defaultTo(0);
    money(t, 'revenue_generated');
    t.string('status', 20).notNullable().defaultTo('active');
    t.string('target_product', 190);
    t.text('notes');
    t.string('legacy_id', 64);
    t.timestamps(true, true);
    t.index(['business_id']);
  });

  await knex.schema.createTable('customers', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('name', 160).notNullable();
    t.string('phone', 40);
    t.string('email', 190);
    t.string('address', 500);
    t.string('city', 100);
    t.string('region', 100);     // drives region commission rates
    t.string('group_name', 100);
    t.string('category', 100);
    t.text('notes');
    t.string('legacy_id', 64);
    t.timestamps(true, true);
    t.index(['business_id', 'phone']);
  });

  await knex.schema.createTable('orders', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('order_number', 60).notNullable();
    t.date('date').notNullable();
    t.integer('customer_id').unsigned().nullable();
    t.string('customer_name', 160).notNullable();
    t.string('customer_phone', 40);
    t.string('customer_email', 190);
    t.json('items').notNullable();   // [{ itemName, sku, quantity, unitPrice, unitCost }]
    money(t, 'subtotal');
    money(t, 'discount');
    money(t, 'delivery_fee');
    money(t, 'total_amount');
    money(t, 'total_cogs');
    t.integer('employee_id').unsigned().nullable();
    money(t, 'commission_earned');
    t.string('delivery_courier', 160);
    money(t, 'delivery_cost');
    t.string('payment_status', 30).notNullable().defaultTo('paid'); // paid | cash_on_delivery | pending | refunded
    t.string('channel', 30).notNullable().defaultTo('manual');
    t.string('actual_payment_method', 30);
    t.text('notes');
    t.string('legacy_id', 64);
    t.timestamps(true, true);
    t.unique(['business_id', 'order_number']);
    t.index(['business_id', 'date']);
  });

  await knex.schema.createTable('deliveries', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('order_id').unsigned().nullable();
    t.string('courier_company', 160);
    t.string('courier_name', 160);
    t.string('courier_phone', 40);
    t.string('tracking_number', 100);
    t.string('customer_name', 160).notNullable();
    t.string('customer_phone', 40);
    t.string('destination_city', 100);
    t.string('address', 500);
    money(t, 'delivery_fee_paid');
    money(t, 'delivery_fee_collected');
    t.string('status', 30).notNullable().defaultTo('pending'); // pending | out_for_delivery | delivered | returned | cancelled
    t.date('date').notNullable();
    t.text('notes');
    t.boolean('cash_remitted').notNullable().defaultTo(false);
    t.timestamp('cash_remitted_at').nullable();
    t.string('legacy_id', 64);
    t.timestamps(true, true);
    t.index(['business_id', 'status']);
  });

  await knex.schema.createTable('budgets', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('category', 60).notNullable();
    money(t, 'monthly_budget');
    t.decimal('alert_threshold_percent', 6, 2).notNullable().defaultTo(80);
    t.string('period_month', 7);   // null/empty = every month
    t.timestamps(true, true);
    t.index(['business_id']);
  });

  await knex.schema.createTable('tickets', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('ticket_number', 30).notNullable();
    t.string('title', 255).notNullable();
    t.string('category', 40).notNullable().defaultTo('general');
    t.string('priority', 20).notNullable().defaultTo('medium');
    t.string('status', 20).notNullable().defaultTo('open');
    t.text('description');
    t.integer('created_by').unsigned();
    t.string('created_by_name', 160);
    t.timestamps(true, true);
    t.index(['business_id', 'status']);
  });
  await knex.schema.createTable('ticket_messages', (t) => {
    t.increments('id');
    t.integer('ticket_id').unsigned().notNullable().references('tickets.id').onDelete('CASCADE');
    t.integer('user_id').unsigned();
    t.string('author_name', 160);
    t.text('body').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ------------------------------------------------------------------ integrations & AI
  await knex.schema.createTable('sheets_connections', (t) => {
    t.integer('business_id').unsigned().primary().references('businesses.id').onDelete('CASCADE');
    t.string('spreadsheet_id', 190);
    t.string('spreadsheet_url', 500);
    t.text('webhook_enc');           // Apps Script web-app URL (encrypted: it grants write access)
    t.string('sync_mode', 20).notNullable().defaultTo('push_only'); // push_only | bidirectional | pull_only
    t.boolean('auto_sync').notNullable().defaultTo(false);
    t.string('status', 20).notNullable().defaultTo('disconnected'); // disconnected | connected | error
    t.timestamp('last_sync_at').nullable();
    t.string('last_error', 500);
    t.timestamps(true, true);
  });
  await knex.schema.createTable('sync_logs', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('direction', 10).notNullable(); // push | pull | test
    t.string('status', 12).notNullable();    // success | failed | sent
    t.integer('rows').notNullable().defaultTo(0);
    t.string('message', 1000);
    t.integer('user_id').unsigned();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'created_at']);
  });

  await knex.schema.createTable('ai_settings', (t) => {
    t.integer('business_id').unsigned().primary().references('businesses.id').onDelete('CASCADE');
    t.string('provider', 20);
    t.string('model', 80);
    t.text('api_key_enc');
    t.boolean('enabled').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });
  await knex.schema.createTable('ai_messages', (t) => {
    t.bigIncrements('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable();
    t.string('role', 12).notNullable();   // user | assistant
    t.text('content').notNullable();
    t.string('source', 20);                // provider name or 'rules'
    t.integer('tokens_in').defaultTo(0);
    t.integer('tokens_out').defaultTo(0);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'user_id']);
  });
};

exports.down = async (knex) => {
  const tables = ['ai_messages', 'ai_settings', 'sync_logs', 'sheets_connections', 'ticket_messages', 'tickets', 'budgets', 'deliveries', 'orders',
    'customers', 'campaigns', 'purchases', 'payroll_payments', 'employees', 'expenses', 'expense_categories', 'profit_distribution_lines',
    'profit_distributions', 'partner_transactions', 'partners', 'notification_reads', 'notifications', 'audit_logs', 'email_verifications',
    'password_resets', 'invitations', 'memberships', 'roles', 'businesses', 'users'];
  for (const t of tables) await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
};
