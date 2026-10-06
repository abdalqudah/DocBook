// Phase 8 — student portal: e-mail verification for self sign-up, in-app notifications with per-user
// preferences, portal messages (a channel next to e-mail / SMS / WhatsApp) and the AI advisor's question log.
exports.up = async (knex) => {
  await knex.schema.createTable('email_verifications', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique();
    t.timestamp('expires_at').notNullable(); t.timestamp('used_at').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('notifications', (t) => {
    t.bigIncrements('id');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('category', 30).notNullable();
    t.string('title_en', 255).notNullable(); t.string('title_ar', 255);
    t.string('body', 500); t.string('href', 500);
    t.timestamp('read_at').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'read_at', 'created_at']);
  });
  await knex.schema.alterTable('users', (t) => { t.json('notification_prefs'); });
  await knex.raw("ALTER TABLE messages MODIFY channel ENUM('email','sms','whatsapp','portal') NOT NULL");
  await knex.raw("ALTER TABLE message_templates MODIFY channel ENUM('email','sms','whatsapp','portal') NOT NULL DEFAULT 'email'");
  await knex.schema.createTable('advisor_logs', (t) => {
    t.bigIncrements('id');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('session_key', 64);
    t.text('question').notNullable(); t.text('answer');
    t.string('mode', 20).notNullable(); // ai | search
    t.string('provider', 30); t.string('model', 60);
    t.json('tools'); t.integer('input_tokens').unsigned(); t.integer('output_tokens').unsigned();
    t.string('error', 255);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['created_at']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('advisor_logs');
  await knex.raw("ALTER TABLE message_templates MODIFY channel ENUM('email','sms','whatsapp') NOT NULL DEFAULT 'email'");
  await knex.raw("ALTER TABLE messages MODIFY channel ENUM('email','sms','whatsapp') NOT NULL");
  await knex.schema.alterTable('users', (t) => { t.dropColumn('notification_prefs'); });
  await knex.schema.dropTableIfExists('notifications');
  await knex.schema.dropTableIfExists('email_verifications');
};
