// Phase 7 — growth: first-party visitors and events (only with analytics consent), lead scoring details,
// campaigns with recipients, and automation rules with their run log.
exports.up = async (knex) => {
  await knex.schema.createTable('visitors', (t) => {
    t.string('id', 40).primary(); // random, set as a first-party cookie after consent
    t.timestamp('first_seen_at').notNullable().defaultTo(knex.fn.now()); t.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
    t.string('landing_page', 500); t.string('referrer', 500);
    t.string('utm_source', 120); t.string('utm_medium', 120); t.string('utm_campaign', 160); t.string('utm_term', 160); t.string('utm_content', 160);
    t.string('last_utm_source', 120); t.string('last_utm_medium', 120); t.string('last_utm_campaign', 160);
    t.enum('device', ['mobile', 'tablet', 'desktop']).nullable();
    t.string('locale', 5);
    t.integer('pageviews').unsigned().notNullable().defaultTo(0);
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('SET NULL');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('SET NULL');
    t.index(['first_seen_at']); t.index(['lead_id']);
  });
  await knex.schema.createTable('tracking_events', (t) => {
    t.bigIncrements('id');
    t.string('visitor_id', 40).notNullable().references('visitors.id').onDelete('CASCADE');
    t.string('name', 40).notNullable();
    t.string('path', 500); t.string('ref_type', 30); t.integer('ref_id').unsigned().nullable();
    t.json('meta');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['visitor_id', 'created_at']); t.index(['name', 'created_at']); t.index(['ref_type', 'ref_id']);
  });
  await knex.schema.alterTable('leads', (t) => {
    t.json('score_reasons'); t.boolean('temperature_manual').notNullable().defaultTo(false); t.timestamp('score_updated_at').nullable();
  });

  await knex.schema.createTable('campaigns', (t) => {
    t.increments('id');
    t.string('name', 160).notNullable(); t.string('slug', 160).notNullable();
    t.enum('channel', ['email', 'sms', 'whatsapp']).notNullable().defaultTo('email');
    t.enum('status', ['draft', 'scheduled', 'sending', 'sent', 'cancelled']).notNullable().defaultTo('draft');
    t.json('segment');
    t.string('subject_en', 255); t.string('subject_ar', 255); t.text('body_en'); t.text('body_ar');
    t.string('cta_en', 80); t.string('cta_ar', 80); t.string('cta_url', 500);
    t.timestamp('scheduled_at').nullable(); t.timestamp('started_at').nullable(); t.timestamp('finished_at').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await knex.schema.createTable('campaign_recipients', (t) => {
    t.increments('id');
    t.integer('campaign_id').unsigned().notNullable().references('campaigns.id').onDelete('CASCADE');
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('SET NULL');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('SET NULL');
    t.string('address', 190).notNullable(); t.string('locale', 5).notNullable().defaultTo('en');
    t.enum('status', ['queued', 'sent', 'failed', 'skipped']).notNullable().defaultTo('queued');
    t.string('error', 255);
    t.string('token', 40).notNullable().unique();
    t.timestamp('sent_at').nullable(); t.timestamp('opened_at').nullable(); t.timestamp('clicked_at').nullable(); t.timestamp('unsubscribed_at').nullable();
    t.index(['campaign_id', 'status']);
  });

  await knex.schema.createTable('automations', (t) => {
    t.increments('id');
    t.string('name', 160).notNullable();
    t.string('trigger', 60).notNullable();
    t.json('conditions'); t.json('actions');
    t.integer('delay_hours').unsigned().notNullable().defaultTo(0); // for time-based triggers
    t.boolean('is_active').notNullable().defaultTo(false);
    t.integer('run_count').unsigned().notNullable().defaultTo(0); t.timestamp('last_run_at').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await knex.schema.createTable('automation_runs', (t) => {
    t.bigIncrements('id');
    t.integer('automation_id').unsigned().notNullable().references('automations.id').onDelete('CASCADE');
    t.string('entity_type', 30); t.integer('entity_id').unsigned().nullable();
    t.enum('status', ['done', 'skipped', 'failed']).notNullable();
    t.string('detail', 500); t.string('dedupe_key', 120).nullable(); // time-based triggers fire once per key
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['automation_id', 'created_at']); t.unique(['automation_id', 'dedupe_key'], { indexName: 'automation_once' });
  });
};

exports.down = async (knex) => {
  for (const t of ['automation_runs', 'automations', 'campaign_recipients', 'campaigns', 'tracking_events', 'visitors']) await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
  await knex.schema.alterTable('leads', (t) => { t.dropColumn('score_reasons'); t.dropColumn('temperature_manual'); t.dropColumn('score_updated_at'); });
};
