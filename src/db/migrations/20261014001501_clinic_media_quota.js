// The media storage of one clinic set by the platform admin (MB). NULL = follow the clinic's package
// (entitlement media.storage_mb), or the platform default while no package applies.
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('businesses', 'media_quota_mb')) return;
  await knex.schema.alterTable('businesses', (t) => { t.integer('media_quota_mb').unsigned().nullable(); });
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('businesses', 'media_quota_mb'))) return;
  await knex.schema.alterTable('businesses', (t) => { t.dropColumn('media_quota_mb'); });
};
