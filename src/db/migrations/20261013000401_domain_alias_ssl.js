// Custom domain, step 2 (DocBook 2.0 redesign 4.9): a clinic may connect the other form of its address (www ↔ bare
// domain) as an alias that redirects to the main one, and DocBook records what it observes about the site's HTTPS
// certificate (the hosting issues certificates; DocBook only checks them). Existing domains become the "primary" row.
exports.up = async (knex) => {
  await knex.schema.alterTable('clinic_domains', (t) => {
    t.string('role', 10).notNullable().defaultTo('primary'); // primary | alias (redirects to the primary)
    t.string('ssl_status', 12).notNullable().defaultTo('unknown'); // unknown | pending | active | expiring | failed
    t.timestamp('ssl_checked_at').nullable();
    t.timestamp('ssl_expires_at').nullable();
    t.string('ssl_error', 120).nullable();
  });
  await knex.schema.alterTable('clinic_domains', (t) => {
    t.unique(['business_id', 'role'], 'clinic_domains_business_role_uq');
  });
  await knex.schema.alterTable('clinic_domains', (t) => {
    t.dropUnique(['business_id'], 'clinic_domains_business_uq');
  });
};

exports.down = async (knex) => {
  await knex('clinic_domains').where({ role: 'alias' }).del();
  await knex.schema.alterTable('clinic_domains', (t) => { t.unique(['business_id'], 'clinic_domains_business_uq'); });
  await knex.schema.alterTable('clinic_domains', (t) => { t.dropUnique(['business_id', 'role'], 'clinic_domains_business_role_uq'); });
  await knex.schema.alterTable('clinic_domains', (t) => {
    t.dropColumn('role'); t.dropColumn('ssl_status'); t.dropColumn('ssl_checked_at'); t.dropColumn('ssl_expires_at'); t.dropColumn('ssl_error');
  });
};
