// The clinic's own wording of the messages patients get (WhatsApp / SMS / e-mail), Arabic and English, and where the
// "rate your visit" link goes (Google or the clinic's own review page). One row per clinic; empty = DocBook's text.
exports.up = async (knex) => {
  if (await knex.schema.hasTable('clinic_messages')) return;
  await knex.schema.createTable('clinic_messages', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().unique().references('businesses.id').onDelete('CASCADE');
    t.text('texts').nullable(); // JSON { "<key>": { ar, en } }
    t.string('review_target', 10).notNullable().defaultTo('auto'); // auto = Google when set, else the site | google | site
    t.integer('updated_by').unsigned().nullable();
    t.timestamps(true, true);
  });
};
exports.down = (knex) => knex.schema.dropTableIfExists('clinic_messages');
