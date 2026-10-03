// Each staff member's own e-mail account, connected to DocBook (IMAP to read, SMTP to send). Personal: only that member
// sees and uses it. Automatic patient messages still go out from the clinic's address (clinic_mail_accounts).
exports.up = async (knex) => {
  if (await knex.schema.hasTable('staff_mailboxes')) return;
  await knex.schema.createTable('staff_mailboxes', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('email', 190).notNullable();
    t.string('display_name', 120).nullable();
    t.string('username', 190).notNullable();
    t.text('secret_enc').notNullable(); // the password (an app password for Gmail / Outlook), encrypted
    t.string('imap_host', 190).notNullable();
    t.integer('imap_port').notNullable().defaultTo(993);
    t.string('smtp_host', 190).notNullable();
    t.integer('smtp_port').notNullable().defaultTo(465);
    t.string('smtp_security', 10).notNullable().defaultTo('ssl'); // ssl | starttls
    t.string('signature', 1000).nullable();
    t.string('last_error', 255).nullable();
    t.timestamp('verified_at').nullable();
    t.timestamps(true, true);
    t.unique(['business_id', 'user_id']);
  });
};
exports.down = (knex) => knex.schema.dropTableIfExists('staff_mailboxes');
