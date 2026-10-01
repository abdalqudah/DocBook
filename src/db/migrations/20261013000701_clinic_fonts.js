// Website fonts uploaded by a clinic (Theme & brand → Fonts): woff2 / woff / ttf / otf, checked by their content,
// stored with the clinic and served from the clinic's own address (same origin, font-src 'self').
exports.up = async (knex) => {
  await knex.schema.createTable('clinic_fonts', (t) => {
    t.increments('id').primary();
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('family', 60).notNullable();
    t.smallint('weight').unsigned().notNullable().defaultTo(400);
    t.string('style', 8).notNullable().defaultTo('normal');
    t.string('format', 8).notNullable();
    t.string('sha', 64).notNullable();
    t.integer('size').unsigned().notNullable();
    t.specificType('data', 'longblob').notNullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['business_id']);
  });
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('clinic_fonts'); };
