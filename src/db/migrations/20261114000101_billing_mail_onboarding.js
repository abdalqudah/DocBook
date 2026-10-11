// When an open subscription invoice was last reminded (overdue), the onboarding e-mails each clinic got, and an
// admin's second sign-in step (TOTP: secret encrypted with APP_KEY, one-time recovery codes as hashes).
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('platform_invoices', 'overdue_reminded_at'))) {
    await knex.schema.alterTable('platform_invoices', (t) => { t.timestamp('overdue_reminded_at').nullable(); });
  }
  if (!(await knex.schema.hasTable('lifecycle_emails'))) {
    await knex.schema.createTable('lifecycle_emails', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('step', 30).notNullable();
      t.string('status', 20).notNullable(); // sent | skipped | failed
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['business_id', 'step']);
    });
  }
  if (!(await knex.schema.hasColumn('users', 'totp_secret_enc'))) {
    await knex.schema.alterTable('users', (t) => {
      t.text('totp_secret_enc').nullable();
      t.timestamp('totp_enabled_at').nullable();
      t.text('totp_recovery').nullable(); // JSON array of sha256 hashes
      t.integer('totp_last_step').nullable(); // the last accepted 30-second step (a code is used once)
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('users', 'totp_secret_enc')) await knex.schema.alterTable('users', (t) => { t.dropColumn('totp_secret_enc'); t.dropColumn('totp_enabled_at'); t.dropColumn('totp_recovery'); t.dropColumn('totp_last_step'); });
  await knex.schema.dropTableIfExists('lifecycle_emails');
  if (await knex.schema.hasColumn('platform_invoices', 'overdue_reminded_at')) await knex.schema.alterTable('platform_invoices', (t) => { t.dropColumn('overdue_reminded_at'); });
};
