// Clinic e-mail (DocBook 2.0 redesign 4.11/4.12): a clinic may send its patient-facing e-mails from its own address
// (its SMTP server, or its Google / Microsoft account). The platform account stays for account e-mails (sign-up,
// password reset, invitations) and as the fallback. Credentials are encrypted (core/secrets) and never shown again.
exports.up = async (knex) => {
  await knex.schema.createTable('clinic_mail_accounts', (t) => {
    t.integer('business_id').unsigned().primary().references('businesses.id').onDelete('CASCADE');
    t.string('provider', 12).notNullable(); // smtp | google | microsoft
    t.string('from_name', 120).nullable();
    t.string('from_address', 190).notNullable();
    t.string('reply_to', 190).nullable();
    t.string('smtp_host', 253).nullable();
    t.integer('smtp_port').unsigned().nullable();
    t.string('smtp_security', 10).nullable(); // ssl | starttls
    t.string('smtp_user', 190).nullable();
    t.text('secret_enc').nullable(); // SMTP password or OAuth refresh token (AES-256-GCM)
    t.string('oauth_account', 190).nullable(); // the Google / Microsoft account that granted sending
    t.json('uses').nullable(); // which kinds of e-mail go out from the clinic address
    t.string('status', 12).notNullable().defaultTo('pending'); // pending | verified | failed
    t.timestamp('verified_at').nullable();
    t.timestamp('last_test_at').nullable();
    t.string('last_error', 250).nullable();
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await knex.schema.createTable('clinic_mail_log', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('kind', 20).notNullable();
    t.string('to_email', 190).notNullable();
    t.string('subject', 190).nullable();
    t.string('status', 10).notNullable(); // sent | failed | fallback | test
    t.string('provider', 12).nullable();
    t.string('error', 250).nullable();
    t.string('message_id', 190).nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'created_at']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('clinic_mail_log');
  await knex.schema.dropTableIfExists('clinic_mail_accounts');
};
