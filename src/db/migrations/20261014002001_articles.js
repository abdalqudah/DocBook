// Articles written by the clinic's doctors (or the clinic), in Arabic and / or English, with a cover and images from
// the clinic's media library. The author chooses where each one appears: the clinic's own website (/<slug>/articles),
// the platform's main site (/blog — after the platform admin approves it), or both.
exports.up = async (knex) => {
  if (await knex.schema.hasTable('articles')) return;
  await knex.schema.createTable('articles', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL'); // null = the clinic
    t.integer('author_user_id').unsigned().nullable();
    t.string('slug', 90).notNullable();
    t.string('title', 200).nullable();
    t.string('title_en', 200).nullable();
    t.string('excerpt', 400).nullable();
    t.string('excerpt_en', 400).nullable();
    t.text('body', 'mediumtext').nullable();
    t.text('body_en', 'mediumtext').nullable();
    t.integer('cover_media_id').unsigned().nullable();
    t.string('category', 60).nullable();
    t.string('status', 12).notNullable().defaultTo('draft'); // draft | published
    t.boolean('on_site').notNullable().defaultTo(true);
    t.boolean('on_platform').notNullable().defaultTo(false);
    t.string('platform_status', 12).notNullable().defaultTo('none'); // none | pending | approved | rejected
    t.string('platform_note', 300).nullable();
    t.timestamp('platform_reviewed_at').nullable();
    t.timestamp('published_at').nullable();
    t.integer('views').unsigned().notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.unique(['business_id', 'slug']);
    t.index(['business_id', 'status', 'published_at']);
    t.index(['on_platform', 'platform_status', 'published_at']);
  });
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('articles'); };
