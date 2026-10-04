// Each clinic (or medical centre) can have its own database (src/db/tenant.js):
//   businesses.db_name   the clinic's database (null = the main database, as before)
// Shared tables (main database) no longer point at a clinic's own tables with foreign keys — those rows move to the
// clinic's database, where a key across databases would block them. The ids stay; the app checks them.
// Self-contained (the release ships migrations as loose files, without src/db): the shared tables as of this migration
// (src/db/tables.js PLATFORM); every other table is a clinic's own.
const PLATFORM = new Set(['users', 'sessions', 'email_verifications', 'password_resets', 'team_user_prefs', 'businesses', 'memberships', 'roles',
  'member_page_access', 'invitations', 'clinic_domains', 'centers', 'center_invites', 'platform_assets', 'platform_settings', 'platform_notifications',
  'platform_payments', 'platform_invoices', 'subscription_plans', 'clinic_subscriptions', 'site_media', 'image_compress_log', 'tenant_dbs',
  'support_tickets', 'support_ticket_replies', 'support_ticket_reads', 'vendors', 'vendor_users', 'vendor_specialties', 'vendor_products',
  'vendor_product_specialties', 'vendor_offers', 'vendor_offer_cities', 'vendor_offer_products', 'vendor_offer_specialties', 'vendor_offer_targets',
  'vendor_offer_views', 'vendor_plans', 'vendor_subscriptions', 'vendor_invoices', 'vendor_ads', 'rep_visits', 'rep_visit_slots', 'purchase_orders',
  'purchase_order_items', 'purchase_receipts', 'reviews', 'articles', 'knex_migrations', 'knex_migrations_lock']);
const isPlatform = (t) => PLATFORM.has(t);
const isTenant = (t) => !PLATFORM.has(t);

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('businesses', 'db_name'))) {
    await knex.schema.alterTable('businesses', (t) => { t.string('db_name', 64).nullable(); t.index(['db_name']); });
  }
  const [rows] = await knex.raw(`SELECT table_name AS t, constraint_name AS c, referenced_table_name AS r FROM information_schema.key_column_usage
    WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`);
  for (const fk of rows) { // eslint-disable-line no-restricted-syntax
    const t = fk.t || fk.TABLE_NAME; const r = fk.r || fk.REFERENCED_TABLE_NAME; const c = fk.c || fk.CONSTRAINT_NAME;
    if (isPlatform(t) && isTenant(r)) await knex.raw('ALTER TABLE ?? DROP FOREIGN KEY ??', [t, c]); // eslint-disable-line no-await-in-loop
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('businesses', 'db_name')) await knex.schema.alterTable('businesses', (t) => { t.dropIndex(['db_name']); t.dropColumn('db_name'); });
};
