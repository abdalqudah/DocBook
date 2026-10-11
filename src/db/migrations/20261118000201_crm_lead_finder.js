// CRM → find clinics on Google: saved searches ("dental clinic" in a city), the places each one found (name, address,
// phone, website, the e-mail read from the website), and whether a place appeared only on a later run (newly listed).
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('crm_lead_searches'))) {
    await knex.schema.createTable('crm_lead_searches', (t) => {
      t.increments('id');
      t.string('query', 190).notNullable();
      t.string('city', 120).nullable();
      t.string('country', 2).nullable();
      t.boolean('auto').notNullable().defaultTo(true); // re-run daily to spot clinics that newly appear
      t.integer('runs').unsigned().notNullable().defaultTo(0);
      t.dateTime('last_run_at').nullable();
      t.string('last_error', 255).nullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamps(true, true);
    });
  }
  if (!(await knex.schema.hasTable('crm_leads'))) {
    await knex.schema.createTable('crm_leads', (t) => {
      t.increments('id');
      t.integer('search_id').unsigned().nullable().references('crm_lead_searches.id').onDelete('SET NULL');
      t.string('place_id', 255).notNullable().unique();
      t.string('name', 190).notNullable();
      t.string('address', 255).nullable();
      t.string('city', 120).nullable();
      t.string('country', 2).nullable();
      t.string('phone', 40).nullable();
      t.string('website', 255).nullable();
      t.string('email', 190).nullable();
      t.string('maps_url', 255).nullable();
      t.decimal('lat', 10, 7).nullable();
      t.decimal('lng', 10, 7).nullable();
      t.integer('reviews').unsigned().nullable();
      t.decimal('rating', 2, 1).nullable();
      t.string('status', 12).notNullable().defaultTo('new'); // new | added | ignored
      t.boolean('is_new_place').notNullable().defaultTo(false); // not in the search's first run: newly on Google
      t.integer('contact_id').unsigned().nullable();
      t.dateTime('first_seen_at').notNullable().defaultTo(knex.fn.now());
      t.dateTime('last_seen_at').nullable();
      t.index(['status']); t.index(['is_new_place']);
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('crm_leads');
  await knex.schema.dropTableIfExists('crm_lead_searches');
};
