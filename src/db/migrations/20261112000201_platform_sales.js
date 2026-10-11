// The platform's sales documents: services catalog, quotations (lines, VAT, the customer's link to accept with a
// signature, decline or negotiate; the team's replies and revisions), a log of every send (e-mail / WhatsApp), share
// links for the platform's subscription invoices, and a log of every e-mail the platform sends.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('sales_services'))) {
    await knex.schema.createTable('sales_services', (t) => {
      t.increments('id');
      t.string('name_ar', 200).notNullable();
      t.string('name_en', 200).nullable();
      t.string('description_ar', 1000).nullable();
      t.string('description_en', 1000).nullable();
      t.string('unit_ar', 60).nullable();
      t.string('unit_en', 60).nullable();
      t.decimal('price', 12, 3).notNullable().defaultTo(0);
      t.boolean('active').notNullable().defaultTo(true);
      t.integer('sort').notNullable().defaultTo(0);
      t.timestamps(true, true);
    });
  }
  if (!(await knex.schema.hasTable('quotes'))) {
    await knex.schema.createTable('quotes', (t) => {
      t.increments('id');
      t.string('number', 40).notNullable().unique();
      t.string('token', 64).notNullable().unique();
      t.integer('contact_id').unsigned().nullable().references('crm_contacts.id').onDelete('SET NULL');
      t.string('customer_name', 150).notNullable();
      t.string('customer_company', 150).nullable();
      t.string('customer_email', 190).nullable();
      t.string('customer_phone', 40).nullable();
      t.string('customer_vat', 40).nullable();
      t.string('customer_address', 255).nullable();
      t.string('locale', 5).notNullable().defaultTo('ar');
      t.string('currency', 3).notNullable().defaultTo('JOD');
      t.date('issue_date').notNullable();
      t.date('valid_until').notNullable();
      t.decimal('subtotal', 12, 3).notNullable().defaultTo(0);
      t.decimal('discount', 12, 3).notNullable().defaultTo(0);
      t.decimal('tax_rate', 5, 2).notNullable().defaultTo(16);
      t.decimal('tax', 12, 3).notNullable().defaultTo(0);
      t.decimal('total', 12, 3).notNullable().defaultTo(0);
      t.text('notes').nullable();
      t.text('terms').nullable();
      t.string('status', 20).notNullable().defaultTo('draft'); // draft | sent | negotiating | accepted | declined
      t.integer('revision').unsigned().notNullable().defaultTo(1);
      t.timestamp('sent_at').nullable();
      t.timestamp('first_viewed_at').nullable();
      t.timestamp('last_viewed_at').nullable();
      t.integer('view_count').unsigned().notNullable().defaultTo(0);
      t.timestamp('responded_at').nullable();
      t.string('response_name', 150).nullable();
      t.string('signer_title', 120).nullable();
      t.specificType('signature', 'mediumblob').nullable(); // the drawn signature (PNG)
      t.string('decline_reason', 40).nullable();
      t.string('response_note', 500).nullable();
      t.string('response_ip', 64).nullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamps(true, true);
      t.index(['status', 'issue_date']);
    });
  }
  if (!(await knex.schema.hasTable('quote_items'))) {
    await knex.schema.createTable('quote_items', (t) => {
      t.increments('id');
      t.integer('quote_id').unsigned().notNullable().references('quotes.id').onDelete('CASCADE');
      t.integer('service_id').unsigned().nullable();
      t.string('description', 500).notNullable();
      t.decimal('quantity', 10, 2).notNullable().defaultTo(1);
      t.decimal('unit_price', 12, 3).notNullable().defaultTo(0);
      t.decimal('amount', 12, 3).notNullable().defaultTo(0);
      t.integer('sort').notNullable().defaultTo(0);
    });
  }
  if (!(await knex.schema.hasTable('quote_events'))) {
    await knex.schema.createTable('quote_events', (t) => {
      t.increments('id');
      t.integer('quote_id').unsigned().notNullable().references('quotes.id').onDelete('CASCADE');
      t.string('type', 30).notNullable(); // negotiation | reply | revised | accepted | declined
      t.string('by', 10).notNullable(); // customer | team
      t.integer('user_id').unsigned().nullable();
      t.string('name', 150).nullable();
      t.decimal('amount', 12, 3).nullable();
      t.text('message').nullable();
      t.integer('revision').unsigned().nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['quote_id']);
    });
  }
  if (!(await knex.schema.hasTable('document_sends'))) {
    await knex.schema.createTable('document_sends', (t) => {
      t.increments('id');
      t.string('doc_type', 20).notNullable(); // quote | invoice
      t.integer('doc_id').unsigned().notNullable();
      t.string('channel', 20).notNullable(); // email | whatsapp
      t.string('recipient', 190).notNullable();
      t.integer('contact_id').unsigned().nullable();
      t.string('status', 20).notNullable(); // sent | failed | opened
      t.string('error', 500).nullable();
      t.string('subject', 200).nullable();
      t.text('body').nullable();
      t.integer('user_id').unsigned().nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['doc_type', 'doc_id']);
    });
  }
  if (!(await knex.schema.hasTable('email_log'))) {
    await knex.schema.createTable('email_log', (t) => {
      t.bigIncrements('id');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.string('kind', 40).notNullable().defaultTo('other');
      t.string('to_addr', 255).notNullable();
      t.string('subject', 255).nullable();
      t.integer('business_id').unsigned().nullable();
      t.string('via', 20).notNullable(); // platform | clinic | none
      t.string('status', 20).notNullable(); // sent | failed | not_sent
      t.string('error', 500).nullable();
      t.index(['created_at']); t.index(['to_addr']);
    });
  }
  for (const [c, f] of [['share_token', (t) => t.string('share_token', 64).nullable().unique()], ['view_count', (t) => t.integer('view_count').unsigned().notNullable().defaultTo(0)], ['last_viewed_at', (t) => t.timestamp('last_viewed_at').nullable()]]) { // eslint-disable-line no-restricted-syntax
    if (!(await knex.schema.hasColumn('platform_invoices', c))) await knex.schema.alterTable('platform_invoices', f); // eslint-disable-line no-await-in-loop
  }
};
exports.down = async (knex) => {
  for (const t of ['document_sends', 'quote_events', 'quote_items', 'quotes', 'sales_services', 'email_log']) await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
};
