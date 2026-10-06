// Phase 13 — home-page hero slider managed in Website → Home slider.
exports.up = async (knex) => {
  await knex.schema.createTable('hero_slides', (t) => {
    t.increments('id');
    t.string('eyebrow_en', 120); t.string('eyebrow_ar', 120);
    t.string('title_en', 190).notNullable(); t.string('title_ar', 190);
    t.string('text_en', 400); t.string('text_ar', 400);
    t.string('image', 500); // photo (media library or https); the illustrated cover shows underneath
    t.string('cover', 30).notNullable().defaultTo('hero');
    t.string('cta_label_en', 60); t.string('cta_label_ar', 60); t.string('cta_href', 300);
    t.string('cta2_label_en', 60); t.string('cta2_label_ar', 60); t.string('cta2_href', 300);
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('hero_slides'); };
