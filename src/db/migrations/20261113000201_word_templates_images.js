// Word (.docx) templates and the filled Word documents made from them, and the pictures placed in online templates.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('document_templates', 'kind'))) {
    await knex.schema.alterTable('document_templates', (t) => {
      t.string('kind', 10).notNullable().defaultTo('text'); // text | docx
      t.specificType('file', 'longblob').nullable();
      t.string('filename', 200).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('sales_documents', 'file'))) {
    await knex.schema.alterTable('sales_documents', (t) => {
      t.specificType('file', 'longblob').nullable();
      t.string('filename', 200).nullable();
    });
  }
  if (!(await knex.schema.hasTable('template_images'))) {
    await knex.schema.createTable('template_images', (t) => {
      t.increments('id');
      t.string('token', 64).notNullable().unique();
      t.string('mime', 60).notNullable();
      t.specificType('data', 'mediumblob').notNullable();
      t.string('name', 200).nullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('template_images');
  if (await knex.schema.hasColumn('sales_documents', 'file')) await knex.schema.alterTable('sales_documents', (t) => { t.dropColumn('file'); t.dropColumn('filename'); });
  if (await knex.schema.hasColumn('document_templates', 'kind')) await knex.schema.alterTable('document_templates', (t) => { t.dropColumn('kind'); t.dropColumn('file'); t.dropColumn('filename'); });
};
