// CRM → find clinics: where a search looks — Google (the Places API with the platform's key), OpenStreetMap (free, no
// key) — or "import" for places uploaded from a file (the Google Maps collector in the admin's own browser, or any list).
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('crm_lead_searches', 'source'))) {
    await knex.schema.alterTable('crm_lead_searches', (t) => { t.string('source', 10).notNullable().defaultTo('google'); });
  }
  if (!(await knex.schema.hasColumn('crm_leads', 'category'))) {
    await knex.schema.alterTable('crm_leads', (t) => { t.string('category', 120).nullable(); });
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('crm_leads', 'category')) await knex.schema.alterTable('crm_leads', (t) => { t.dropColumn('category'); });
  if (await knex.schema.hasColumn('crm_lead_searches', 'source')) await knex.schema.alterTable('crm_lead_searches', (t) => { t.dropColumn('source'); });
};
