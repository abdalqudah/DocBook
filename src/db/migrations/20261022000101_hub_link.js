// Linking a DocBook installed on a clinic's own server (e.g. one clinic's own site) to the DocBook platform:
//   on the platform — hub_links: each linked installation (its key's SHA-256 only, its clinic's public details, last
//   contact); reps see these clinics; the installation reads the reps' offers and ads through /hub/v1.
//   on the installation — hub_client (one row): the platform's address and the key (encrypted), last sync; hub_cache:
//   the offers and ads read from the platform (with their images), shown in the clinic's Marketplace and dashboard.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('hub_links'))) {
    await knex.schema.createTable('hub_links', (t) => {
      t.increments('id');
      t.string('label', 120).notNullable();
      t.string('key_hash', 64).notNullable().unique();
      t.string('key_prefix', 12).notNullable();
      t.string('status', 10).notNullable().defaultTo('active'); // active | revoked
      t.string('name', 190).nullable();
      t.string('name_en', 190).nullable();
      t.string('specialty', 60).nullable();
      t.string('city', 120).nullable();
      t.string('phone', 40).nullable();
      t.string('whatsapp', 40).nullable();
      t.string('site_url', 300).nullable();
      t.string('version', 30).nullable();
      t.timestamp('last_seen_at').nullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamps(true, true);
    });
  }
  if (!(await knex.schema.hasTable('hub_client'))) {
    await knex.schema.createTable('hub_client', (t) => {
      t.integer('id').unsigned().primary(); // always 1
      t.string('hub_url', 300).nullable();
      t.text('key_enc').nullable();
      t.boolean('enabled').notNullable().defaultTo(false);
      t.timestamp('last_sync_at').nullable();
      t.string('last_error', 255).nullable();
      t.integer('offers').unsigned().notNullable().defaultTo(0);
      t.integer('ads').unsigned().notNullable().defaultTo(0);
      t.timestamps(true, true);
    });
  }
  if (!(await knex.schema.hasTable('hub_cache'))) {
    await knex.schema.createTable('hub_cache', (t) => {
      t.increments('id');
      t.string('kind', 8).notNullable(); // offer | ad
      t.integer('remote_id').unsigned().notNullable();
      t.text('data', 'mediumtext').notNullable(); // JSON as the platform sent it
      t.specificType('image', 'MEDIUMBLOB').nullable();
      t.string('image_mime', 60).nullable();
      t.timestamp('fetched_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['kind', 'remote_id'], 'hubcache_uq');
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('hub_cache');
  await knex.schema.dropTableIfExists('hub_client');
  await knex.schema.dropTableIfExists('hub_links');
};
