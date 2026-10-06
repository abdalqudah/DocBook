// Phase 16 — marketing: newsletter subscribers (double opt-in), subscribers as a campaign audience, saved UTM links.
exports.up = async (knex) => {
  await knex.schema.createTable('newsletter_subscribers', (t) => {
    t.increments('id');
    t.string('email', 190).notNullable().unique();
    t.string('name', 160);
    t.string('locale', 5).notNullable().defaultTo('en');
    t.json('interests'); // destination country codes
    t.string('degree', 30);
    t.enum('status', ['pending', 'confirmed', 'unsubscribed']).notNullable().defaultTo('pending');
    t.string('source', 60);
    t.string('utm_source', 120); t.string('utm_medium', 120); t.string('utm_campaign', 160);
    t.string('confirm_token', 64).unique();
    t.string('manage_token', 64).notNullable().unique();
    t.string('consent_text', 500); t.string('consent_ip', 64);
    t.timestamp('confirm_sent_at').nullable(); t.timestamp('confirmed_at').nullable(); t.timestamp('unsubscribed_at').nullable();
    t.timestamps(true, true);
    t.index(['status']);
  });
  await knex.schema.alterTable('campaign_recipients', (t) => {
    t.integer('subscriber_id').unsigned().nullable().references('newsletter_subscribers.id').onDelete('SET NULL');
  });
  await knex.schema.createTable('utm_links', (t) => {
    t.increments('id');
    t.string('name', 160).notNullable();
    t.string('url', 500).notNullable();
    t.string('utm_source', 120).notNullable(); t.string('utm_medium', 120).notNullable(); t.string('utm_campaign', 160).notNullable();
    t.string('utm_term', 160); t.string('utm_content', 160);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('utm_links');
  await knex.schema.alterTable('campaign_recipients', (t) => { t.dropForeign(['subscriber_id']); t.dropColumn('subscriber_id'); });
  await knex.schema.dropTableIfExists('newsletter_subscribers');
};
