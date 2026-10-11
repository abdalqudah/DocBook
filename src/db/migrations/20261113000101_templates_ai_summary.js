// The platform's document templates (text with {placeholders}: agreements, offers, letters), the documents made from
// them for a customer (each with its own link to view and print, sent by e-mail or WhatsApp), and the AI summary
// kept on a CRM contact.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('document_templates'))) {
    await knex.schema.createTable('document_templates', (t) => {
      t.increments('id');
      t.string('name', 150).notNullable();
      t.string('locale', 5).notNullable().defaultTo('ar');
      t.text('body').notNullable();
      t.boolean('active').notNullable().defaultTo(true);
      t.integer('created_by').unsigned().nullable();
      t.timestamps(true, true);
    });
  }
  if (!(await knex.schema.hasTable('sales_documents'))) {
    await knex.schema.createTable('sales_documents', (t) => {
      t.increments('id');
      t.integer('template_id').unsigned().nullable().references('document_templates.id').onDelete('SET NULL');
      t.integer('contact_id').unsigned().nullable().references('crm_contacts.id').onDelete('SET NULL');
      t.string('title', 150).notNullable();
      t.string('locale', 5).notNullable().defaultTo('ar');
      t.text('body', 'mediumtext').notNullable();
      t.string('token', 64).notNullable().unique();
      t.string('recipient_name', 150).nullable();
      t.string('recipient_email', 190).nullable();
      t.string('recipient_phone', 40).nullable();
      t.integer('view_count').unsigned().notNullable().defaultTo(0);
      t.timestamp('last_viewed_at').nullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamps(true, true);
      t.index(['contact_id']);
    });
  }
  if (!(await knex.schema.hasColumn('crm_contacts', 'ai_summary'))) {
    await knex.schema.alterTable('crm_contacts', (t) => { t.text('ai_summary').nullable(); t.timestamp('ai_summary_at').nullable(); });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('crm_contacts', 'ai_summary')) await knex.schema.alterTable('crm_contacts', (t) => { t.dropColumn('ai_summary'); t.dropColumn('ai_summary_at'); });
  await knex.schema.dropTableIfExists('sales_documents');
  await knex.schema.dropTableIfExists('document_templates');
};
