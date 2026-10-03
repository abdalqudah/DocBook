// Insurance statements: each insurance company's e-mail (where its claims statement is sent) and the log of the
// statements made (period, number of invoices, the insurer's total, downloaded or e-mailed and to whom).
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('insurance_providers', 'email'))) {
    await knex.schema.alterTable('insurance_providers', (t) => { t.string('email', 190).nullable(); t.string('contact_name', 190).nullable(); });
  }
  if (!(await knex.schema.hasTable('insurance_statements'))) {
    await knex.schema.createTable('insurance_statements', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('provider_id').unsigned().nullable();
      t.string('provider_name', 190).notNullable();
      t.date('date_from').notNullable();
      t.date('date_to').notNullable();
      t.integer('invoices').unsigned().notNullable();
      t.decimal('total', 15, 3).notNullable(); // the insurer's share
      t.string('action', 10).notNullable(); // pdf | xlsx | email
      t.string('sent_to', 190).nullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['business_id', 'created_at']);
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('insurance_statements');
  if (await knex.schema.hasColumn('insurance_providers', 'email')) await knex.schema.alterTable('insurance_providers', (t) => { t.dropColumn('email'); t.dropColumn('contact_name'); });
};
