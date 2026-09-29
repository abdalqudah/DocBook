// Sign in with Google (the Google account linked to a DocBook login) and verified custom domains for clinic pages.
exports.up = async (knex) => {
  await knex.schema.alterTable('users', (t) => {
    t.string('google_sub', 64).nullable();          // Google's stable account id ("sub" claim)
    t.string('google_email', 190).nullable();       // the Google address it was linked with (shown in Settings → Security)
    t.timestamp('google_linked_at').nullable();
    t.unique(['google_sub'], 'users_google_sub_uq');
  });
  // One custom domain per clinic. A host may be claimed by several clinics while pending,
  // but only one clinic can have it verified (enforced in domain.service).
  await knex.schema.createTable('clinic_domains', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('id').inTable('businesses').onDelete('CASCADE');
    t.string('host', 253).notNullable();
    t.string('status', 20).notNullable().defaultTo('pending'); // pending (waiting for DNS) | verified (live) | suspended (stopped by the platform team)
    t.string('token', 64).notNullable();                       // value of the ownership TXT record
    t.timestamp('checked_at').nullable();
    t.timestamp('verified_at').nullable();
    t.text('last_check').nullable();                           // JSON result of the last DNS lookup
    t.integer('created_by').unsigned().nullable();
    t.timestamps(true, true);
    t.unique(['business_id'], 'clinic_domains_business_uq');
    t.index(['host', 'status'], 'clinic_domains_host_idx');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('clinic_domains');
  await knex.schema.alterTable('users', (t) => {
    t.dropUnique(['google_sub'], 'users_google_sub_uq');
    t.dropColumn('google_sub'); t.dropColumn('google_email'); t.dropColumn('google_linked_at');
  });
};
