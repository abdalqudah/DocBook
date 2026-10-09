// Patient portal: a patient signs in to the clinic's site (/<slug>/account) with the mobile or e-mail of the file and a
// password, and sees what the clinic chose to show (visits, visit records, prescriptions, files, treatment plan).
//   • patient_accounts: one per patient (unique), its sign-in (phone digits / e-mail), password hash, lock-out.
//   • patient_account_codes: one-time codes and links (sign-up, reset, invitation) — only their SHA-256 is kept;
//     a short life, a few tries, used once.
//   • patient_portal_settings: per clinic — on/off, self sign-up, each section shown or not, the WhatsApp template
//     for codes.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('patient_accounts'))) {
    await knex.schema.createTable('patient_accounts', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
      t.string('login_phone', 40).nullable(); // digits, international form
      t.string('login_email', 190).nullable(); // lower case
      t.string('password_hash', 100).nullable(); // null until the patient sets one (an invitation)
      t.string('status', 12).notNullable().defaultTo('active'); // active | disabled
      t.integer('failed_count').unsigned().notNullable().defaultTo(0);
      t.timestamp('locked_until').nullable();
      t.timestamp('last_login_at').nullable();
      t.timestamps(true, true);
      t.unique(['business_id', 'patient_id'], 'pacc_patient_uq');
      t.index(['business_id', 'login_phone'], 'pacc_phone_idx');
      t.index(['business_id', 'login_email'], 'pacc_email_idx');
    });
  }
  if (!(await knex.schema.hasTable('patient_account_codes'))) {
    await knex.schema.createTable('patient_account_codes', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
      t.string('purpose', 12).notNullable(); // signup | reset | invite
      t.string('code_hash', 64).notNullable(); // SHA-256 of the 6-digit code (or of the link's token)
      t.string('channel', 10).nullable(); // whatsapp | sms | email
      t.integer('attempts').unsigned().notNullable().defaultTo(0);
      t.timestamp('expires_at').notNullable();
      t.timestamp('used_at').nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['business_id', 'patient_id', 'purpose'], 'pacode_patient_idx');
      t.index(['code_hash'], 'pacode_hash_idx');
    });
  }
  if (!(await knex.schema.hasTable('patient_portal_settings'))) {
    await knex.schema.createTable('patient_portal_settings', (t) => {
      t.integer('business_id').unsigned().primary().references('businesses.id').onDelete('CASCADE');
      t.boolean('enabled').notNullable().defaultTo(false);
      t.boolean('self_signup').notNullable().defaultTo(true);
      t.boolean('show_visits').notNullable().defaultTo(true);
      t.boolean('show_records').notNullable().defaultTo(false);
      t.boolean('show_prescriptions').notNullable().defaultTo(true);
      t.boolean('show_files').notNullable().defaultTo(false);
      t.boolean('show_plan').notNullable().defaultTo(true);
      t.string('wa_template', 120).nullable(); // a WhatsApp authentication template with the code as its one parameter
      t.integer('updated_by').unsigned().nullable();
      t.timestamps(true, true);
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('patient_account_codes');
  await knex.schema.dropTableIfExists('patient_accounts');
  await knex.schema.dropTableIfExists('patient_portal_settings');
};
