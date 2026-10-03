// Patient file imports: which record of the exported file (its source clinic + kind + id there) became which row
// here, so importing the same file again adds only what is missing and never doubles a visit or a file.
exports.up = async (knex) => {
  if (await knex.schema.hasTable('import_links')) return;
  await knex.schema.createTable('import_links', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('source_key', 80).notNullable();
    t.string('kind', 24).notNullable();
    t.integer('src_id').unsigned().notNullable();
    t.integer('new_id').unsigned().notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['business_id', 'source_key', 'kind', 'src_id']);
  });
};

exports.down = async (knex) => { await knex.schema.dropTableIfExists('import_links'); };
