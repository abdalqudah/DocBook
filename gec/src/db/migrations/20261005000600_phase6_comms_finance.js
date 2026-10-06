// Phase 6 — communications (message log, editable templates) and finance (invoices, payments, university partner
// agreements, commissions). Money is stored as DECIMAL(12,2) in the record's own currency.
exports.up = async (knex) => {
  await knex.schema.createTable('message_templates', (t) => {
    t.increments('id');
    t.string('key', 60).notNullable();
    t.enum('channel', ['email', 'sms', 'whatsapp']).notNullable().defaultTo('email');
    t.string('locale', 5).notNullable();
    t.string('name', 120); // for custom templates
    t.string('subject', 255); t.text('body').notNullable(); t.string('cta_label', 80);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['key', 'channel', 'locale']);
  });
  await knex.schema.createTable('messages', (t) => {
    t.increments('id');
    t.enum('channel', ['email', 'sms', 'whatsapp']).notNullable();
    t.enum('direction', ['out', 'in']).notNullable().defaultTo('out');
    t.enum('status', ['sent', 'delivered', 'read', 'failed', 'not_configured', 'received', 'manual']).notNullable();
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('SET NULL');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('SET NULL');
    t.string('to_address', 190); t.string('from_address', 190);
    t.string('subject', 255); t.text('body');
    t.string('template_key', 60); t.boolean('automated').notNullable().defaultTo(false);
    t.string('provider', 30); t.string('provider_message_id', 190); t.string('error', 500);
    t.integer('sent_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('read_at').nullable(); // inbound: when a staff member opened it
    t.integer('branch_id').unsigned().nullable().references('branches.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['lead_id']); t.index(['student_id']); t.index(['direction', 'read_at']); t.index(['created_at']); t.index(['provider_message_id']);
  });

  await knex.schema.createTable('counters', (t) => { t.string('key', 40).primary(); t.integer('value').unsigned().notNullable().defaultTo(0); });

  await knex.schema.createTable('invoices', (t) => {
    t.increments('id');
    t.string('number', 30).notNullable().unique();
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('SET NULL');
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('SET NULL');
    t.integer('application_id').unsigned().nullable().references('applications.id').onDelete('SET NULL');
    t.string('bill_to_name', 190).notNullable(); t.string('bill_to_email', 190); t.string('bill_to_phone', 40); t.string('bill_to_address', 500);
    t.string('currency', 3).notNullable();
    t.enum('status', ['draft', 'issued', 'partially_paid', 'paid', 'void']).notNullable().defaultTo('draft');
    t.string('locale', 5).notNullable().defaultTo('en');
    t.date('issue_date').nullable(); t.date('due_date').nullable();
    t.decimal('subtotal', 12, 2).notNullable().defaultTo(0); t.decimal('discount', 12, 2).notNullable().defaultTo(0);
    t.decimal('tax_rate', 5, 2).notNullable().defaultTo(0); t.decimal('tax', 12, 2).notNullable().defaultTo(0);
    t.decimal('total', 12, 2).notNullable().defaultTo(0); t.decimal('paid', 12, 2).notNullable().defaultTo(0);
    t.text('notes'); t.string('void_reason', 255);
    t.string('public_token', 40).unique();
    t.integer('branch_id').unsigned().nullable().references('branches.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['status', 'due_date']); t.index(['student_id']);
  });
  await knex.schema.createTable('invoice_items', (t) => {
    t.increments('id');
    t.integer('invoice_id').unsigned().notNullable().references('invoices.id').onDelete('CASCADE');
    t.string('description', 255).notNullable();
    t.decimal('quantity', 8, 2).notNullable().defaultTo(1); t.decimal('unit_price', 12, 2).notNullable(); t.decimal('amount', 12, 2).notNullable();
    t.integer('position').notNullable().defaultTo(0);
  });
  await knex.schema.createTable('payments', (t) => {
    t.increments('id');
    t.string('receipt_no', 30).notNullable().unique();
    t.integer('invoice_id').unsigned().nullable().references('invoices.id').onDelete('SET NULL');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('SET NULL');
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('SET NULL');
    t.integer('course_registration_id').unsigned().nullable().references('course_registrations.id').onDelete('SET NULL');
    t.decimal('amount', 12, 2).notNullable(); t.string('currency', 3).notNullable();
    t.enum('method', ['cash', 'bank_transfer', 'card', 'online', 'cheque', 'other']).notNullable();
    t.string('reference', 120);
    t.enum('status', ['received', 'refunded']).notNullable().defaultTo('received');
    t.date('received_on').notNullable();
    t.string('notes', 500); t.string('refund_reason', 255);
    t.integer('received_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('branch_id').unsigned().nullable().references('branches.id').onDelete('SET NULL');
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['received_on']);
  });

  await knex.schema.createTable('partners', (t) => {
    t.increments('id');
    t.integer('university_id').unsigned().notNullable().references('universities.id').onDelete('CASCADE');
    t.enum('status', ['prospect', 'pending', 'active', 'expired', 'terminated']).notNullable().defaultTo('active');
    t.date('starts_on').nullable(); t.date('ends_on').nullable();
    t.enum('commission_type', ['percent', 'fixed']).notNullable().defaultTo('percent');
    t.decimal('commission_rate', 10, 2).notNullable().defaultTo(0); // percent of first-year tuition, or a fixed amount
    t.string('currency', 3);
    t.integer('payment_terms_days').unsigned().nullable();
    t.string('contact_name', 160); t.string('contact_email', 190); t.string('contact_phone', 40);
    t.string('agreement_ref', 120); t.text('notes');
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['university_id', 'status']);
  });
  await knex.schema.createTable('commissions', (t) => {
    t.increments('id');
    t.integer('partner_id').unsigned().nullable().references('partners.id').onDelete('SET NULL');
    t.integer('university_id').unsigned().nullable().references('universities.id').onDelete('SET NULL');
    t.integer('application_id').unsigned().nullable().references('applications.id').onDelete('SET NULL');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('SET NULL');
    t.decimal('expected_amount', 12, 2).notNullable().defaultTo(0); t.decimal('received_amount', 12, 2).nullable();
    t.string('currency', 3).notNullable();
    t.enum('status', ['expected', 'invoiced', 'received', 'written_off']).notNullable().defaultTo('expected');
    t.date('due_on').nullable(); t.date('received_on').nullable();
    t.string('basis', 255); t.string('notes', 500);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.unique(['application_id']);
  });
};

exports.down = async (knex) => {
  for (const t of ['commissions', 'partners', 'payments', 'invoice_items', 'invoices', 'counters', 'messages', 'message_templates']) await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
};
