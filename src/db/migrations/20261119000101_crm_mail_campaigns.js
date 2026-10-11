// CRM → bulk e-mail: a campaign (subject, text, an optional button) sent to the contacts chosen for it, at most so many
// an hour and a day (its own limits, inside the platform's overall limits), with an unsubscribe link in every e-mail.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('mail_campaigns'))) {
    await knex.schema.createTable('mail_campaigns', (t) => {
      t.increments('id');
      t.string('name', 190).notNullable();
      t.string('subject', 255).notNullable();
      t.text('body').notNullable();
      t.string('cta_label', 80).nullable();
      t.string('cta_url', 500).nullable();
      t.string('locale', 2).notNullable().defaultTo('ar');
      t.string('status', 12).notNullable().defaultTo('draft'); // draft | sending | paused | done | cancelled
      t.integer('per_hour').unsigned().notNullable().defaultTo(50);
      t.integer('per_day').unsigned().notNullable().defaultTo(300);
      t.dateTime('start_at').nullable(); // not before (optional)
      t.dateTime('started_at').nullable();
      t.dateTime('finished_at').nullable();
      t.string('last_error', 255).nullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamps(true, true);
      t.index(['status']);
    });
  }
  if (!(await knex.schema.hasTable('mail_campaign_recipients'))) {
    await knex.schema.createTable('mail_campaign_recipients', (t) => {
      t.increments('id');
      t.integer('campaign_id').unsigned().notNullable().references('mail_campaigns.id').onDelete('CASCADE');
      t.integer('contact_id').unsigned().nullable();
      t.string('email', 190).notNullable();
      t.string('name', 190).nullable();
      t.string('organization', 190).nullable();
      t.string('status', 10).notNullable().defaultTo('queued'); // queued | sent | failed | skipped
      t.string('error', 255).nullable();
      t.string('token', 40).notNullable().unique(); // the unsubscribe link
      t.dateTime('sent_at').nullable();
      t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['campaign_id', 'email']);
      t.index(['campaign_id', 'status']);
      t.index(['sent_at']);
    });
  }
  if (!(await knex.schema.hasTable('mail_unsubscribes'))) {
    await knex.schema.createTable('mail_unsubscribes', (t) => {
      t.increments('id');
      t.string('email', 190).notNullable().unique();
      t.integer('campaign_id').unsigned().nullable();
      t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('mail_campaign_recipients');
  await knex.schema.dropTableIfExists('mail_campaigns');
  await knex.schema.dropTableIfExists('mail_unsubscribes');
};
