// Platform link, both ways: reps on the platform book visits at a linked installation's clinic, live.
//   • hub_links.callback_url / callback_enc: where the platform reaches the installation, and the secret the
//     installation gave in its hello (encrypted) — the platform calls it for doctors, free times and bookings.
//   • hub_client.callback_enc: the installation's own copy of that secret (to check the platform's calls).
//   • hub_visits (platform): a rep's visit at a linked clinic — the installation keeps the visit itself
//     (rep_visits, with a local stand-in for the rep: vendors.hub_vendor_id) and tells the platform each decision.
exports.up = async (knex) => {
  const col = async (table, name, fn) => { if (await knex.schema.hasTable(table) && !(await knex.schema.hasColumn(table, name))) await knex.schema.alterTable(table, fn); };
  await col('hub_links', 'callback_url', (t) => { t.string('callback_url', 300).nullable(); });
  await col('hub_links', 'callback_enc', (t) => { t.text('callback_enc').nullable(); });
  await col('hub_client', 'callback_enc', (t) => { t.text('callback_enc').nullable(); });
  await col('hub_client', 'callback_url', (t) => { t.string('callback_url', 300).nullable(); });
  await col('vendors', 'hub_vendor_id', (t) => { t.integer('hub_vendor_id').unsigned().nullable().index('vendors_hub_idx'); });
  if (!(await knex.schema.hasTable('hub_visits'))) {
    await knex.schema.createTable('hub_visits', (t) => {
      t.increments('id');
      t.integer('link_id').unsigned().notNullable().references('hub_links.id').onDelete('CASCADE');
      t.integer('vendor_id').unsigned().notNullable().references('vendors.id').onDelete('CASCADE');
      t.integer('user_id').unsigned().nullable();
      t.integer('remote_id').unsigned().notNullable(); // the visit's id at the installation
      t.string('doctor_name', 190).nullable();
      t.date('visit_date').notNullable();
      t.string('visit_time', 5).notNullable();
      t.string('purpose', 500).nullable();
      t.string('status', 20).notNullable().defaultTo('requested');
      t.string('clinic_note', 500).nullable();
      t.timestamps(true, true);
      t.unique(['link_id', 'remote_id'], 'hubvisit_uq');
      t.index(['vendor_id', 'visit_date'], 'hubvisit_vendor_idx');
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('hub_visits');
  const drop = async (table, name) => { if (await knex.schema.hasTable(table) && await knex.schema.hasColumn(table, name)) await knex.schema.alterTable(table, (t) => { t.dropColumn(name); }); };
  await drop('vendors', 'hub_vendor_id'); await drop('hub_client', 'callback_url'); await drop('hub_client', 'callback_enc'); await drop('hub_links', 'callback_enc'); await drop('hub_links', 'callback_url');
};
