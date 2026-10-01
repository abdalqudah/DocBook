// Browser icons and the platform's own logo.
//   • businesses.favicon_mode: 'platform' (the product's icon, as before), 'logo' (the clinic logo) or 'custom'
//     (favicon / favicon_mime / favicon_version: an uploaded icon) — used on the clinic's public pages and in the app.
//   • platform_assets: images the platform admin uploads (logo, logo on dark, favicon) instead of the built-in mark.
exports.up = async (knex) => {
  const col = async (name, fn) => { if (!(await knex.schema.hasColumn('businesses', name))) await knex.schema.alterTable('businesses', fn); };
  await col('favicon_mode', (t) => { t.string('favicon_mode', 12).notNullable().defaultTo('platform'); });
  await col('favicon', (t) => { t.specificType('favicon', 'MEDIUMBLOB').nullable(); });
  await col('favicon_mime', (t) => { t.string('favicon_mime', 40).nullable(); });
  await col('favicon_version', (t) => { t.integer('favicon_version').unsigned().notNullable().defaultTo(0); });
  if (!(await knex.schema.hasTable('platform_assets'))) {
    await knex.schema.createTable('platform_assets', (t) => {
      t.string('key', 32).primary();
      t.string('mime', 40).notNullable();
      t.specificType('data', 'MEDIUMBLOB').notNullable();
      t.integer('version').unsigned().notNullable().defaultTo(1);
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('platform_assets');
  for (const c of ['favicon_version', 'favicon_mime', 'favicon', 'favicon_mode']) {
    if (await knex.schema.hasColumn('businesses', c)) await knex.schema.alterTable('businesses', (t) => { t.dropColumn(c); }); // eslint-disable-line no-await-in-loop
  }
};
