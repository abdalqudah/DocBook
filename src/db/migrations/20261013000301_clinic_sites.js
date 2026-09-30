// Clinic website: draft → preview → publish (DocBook 2.0 redesign 4.4).
//  • clinic_sites: one row per clinic that has opened the website builder. No row = the classic clinic page stays live
//    exactly as before (nothing changes for a clinic until it publishes from the builder or takes the site down).
//  • clinic_site_versions: the draft (one per clinic), the published version, and older published versions kept for
//    "restore" (restoring copies an old version into the draft; it never goes live by itself).
// The website stores presentation and editorial content only; clinic facts (doctors, services, prices, hours,
// insurers, reviews, address) are read live from their own tables when the page is shown.
exports.up = async (knex) => {
  await knex.schema.createTable('clinic_sites', (t) => {
    t.integer('business_id').unsigned().primary().references('businesses.id').onDelete('CASCADE');
    t.string('status', 12).notNullable().defaultTo('draft'); // draft (never published) | live | unpublished
    t.integer('draft_version_id').unsigned().nullable();
    t.integer('live_version_id').unsigned().nullable();
    t.timestamp('published_at').nullable();
    t.integer('published_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('draft_updated_at').nullable();
    t.integer('draft_updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await knex.schema.createTable('clinic_site_versions', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('kind', 10).notNullable(); // draft | published | archived
    t.json('doc').notNullable();
    t.integer('schema_version').unsigned().notNullable().defaultTo(1);
    t.string('note', 190).nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'kind']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('clinic_site_versions');
  await knex.schema.dropTableIfExists('clinic_sites');
};
