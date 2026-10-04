// Platform admin → Compress old images: one row per stored picture tried (done / kept as it was / failed), so a
// picture is never tried twice and the page can show how much space was saved.
exports.up = async (knex) => {
  if (await knex.schema.hasTable('image_compress_log')) return;
  await knex.schema.createTable('image_compress_log', (t) => {
    t.increments('id');
    t.string('target', 40).notNullable();
    t.integer('row_id').unsigned().notNullable();
    t.string('status', 10).notNullable(); // done | kept | failed
    t.integer('bytes_before').unsigned().notNullable().defaultTo(0);
    t.integer('bytes_after').unsigned().notNullable().defaultTo(0);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['target', 'row_id']);
  });
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('image_compress_log'); };
