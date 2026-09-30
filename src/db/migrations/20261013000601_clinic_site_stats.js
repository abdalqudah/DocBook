// Website statistics (DocBook 2.0 redesign 4.14): first-party daily counters of public page views — no cookies, no
// visitor identifiers, no IP addresses; one row per clinic, day and page kind (home | doctor | book).
exports.up = async (knex) => {
  await knex.schema.createTable('clinic_site_stats', (t) => {
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.date('day').notNullable();
    t.string('kind', 12).notNullable();
    t.integer('views').unsigned().notNullable().defaultTo(0);
    t.primary(['business_id', 'day', 'kind']);
  });
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('clinic_site_stats'); };
