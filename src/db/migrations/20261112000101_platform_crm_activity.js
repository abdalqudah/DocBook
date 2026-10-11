// The platform owner's tools: a CRM (contacts — clinics, warehouses, reps, prospects — with their activity) and who
// is active on the platform now and from where (one row per account, refreshed while it is used; IP places cached).
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('crm_contacts'))) {
    await knex.schema.createTable('crm_contacts', (t) => {
      t.increments('id');
      t.string('kind', 20).notNullable().defaultTo('prospect'); // clinic | warehouse | rep | prospect | partner | other
      t.string('name', 190).notNullable();
      t.string('organization', 190).nullable();
      t.string('phone', 40).nullable();
      t.string('whatsapp', 40).nullable();
      t.string('email', 190).nullable();
      t.string('country', 2).nullable();
      t.string('city', 120).nullable();
      t.string('stage', 20).notNullable().defaultTo('new'); // new | contacted | interested | demo | trial | customer | lost
      t.string('source', 20).nullable(); // signup | website | whatsapp | call | referral | event | import | other
      t.integer('business_id').unsigned().nullable().index();
      t.integer('vendor_id').unsigned().nullable().index();
      t.string('next_action', 255).nullable();
      t.dateTime('next_action_at').nullable().index();
      t.text('notes').nullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamps(true, true);
      t.index(['stage']); t.index(['country']);
    });
  }
  if (!(await knex.schema.hasTable('crm_activities'))) {
    await knex.schema.createTable('crm_activities', (t) => {
      t.increments('id');
      t.integer('contact_id').unsigned().notNullable().references('crm_contacts.id').onDelete('CASCADE');
      t.string('kind', 20).notNullable(); // note | call | email | whatsapp | meeting | stage
      t.text('body').nullable();
      t.string('status', 20).nullable(); // sent | failed (e-mail, WhatsApp)
      t.integer('user_id').unsigned().nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['contact_id', 'created_at']);
    });
  }
  if (!(await knex.schema.hasTable('platform_activity'))) {
    await knex.schema.createTable('platform_activity', (t) => {
      t.integer('user_id').unsigned().primary();
      t.string('kind', 12).notNullable().defaultTo('clinic'); // clinic | vendor | admin | other
      t.integer('business_id').unsigned().nullable();
      t.integer('vendor_id').unsigned().nullable();
      t.dateTime('last_seen_at').notNullable().index();
      t.string('ip', 64).nullable();
      t.string('country', 2).nullable();
      t.string('user_agent', 255).nullable();
      t.string('path', 190).nullable();
    });
  }
  if (!(await knex.schema.hasTable('ip_places'))) {
    await knex.schema.createTable('ip_places', (t) => {
      t.string('ip', 64).primary();
      t.string('country', 2).nullable();
      t.string('city', 120).nullable();
      t.timestamp('looked_up_at').notNullable().defaultTo(knex.fn.now());
    });
  }
};
exports.down = async (knex) => {
  for (const t of ['crm_activities', 'crm_contacts', 'platform_activity', 'ip_places']) await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
};
