// Moving or sharing patients between the clinics of one owner (src/modules/patienttransfer). The clinics may live in
// different databases, so what ties them is kept in the main database:
//  • patient_transfers / patient_transfer_items: one transfer (from one clinic to another: move, share or update)
//    and one row per patient with its own status, so a stopped transfer carries on and a failure is visible.
//  • patient_links: a patient known in two clinics — shared (seen in both), or moved (from / to) — one row each way.
// And in each clinic:
//  • patients.transferred_*: a patient moved to another clinic stays here as a read-only archive (hidden from the
//    patient list), with where and when it went.
exports.up = async (knex) => {
  const add = async (table, name, fn) => { if (!(await knex.schema.hasColumn(table, name))) await knex.schema.alterTable(table, fn); };
  await add('patients', 'transferred_to_business_id', (t) => { t.integer('transferred_to_business_id').unsigned().nullable(); });
  await add('patients', 'transferred_patient_id', (t) => { t.integer('transferred_patient_id').unsigned().nullable(); });
  await add('patients', 'transferred_at', (t) => { t.timestamp('transferred_at').nullable(); });

  await knex.schema.createTable('patient_transfers', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('from_business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('to_business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('mode', 10).notNullable(); // move | share | sync
    t.string('status', 24).notNullable().defaultTo('queued'); // queued | running | done | done_with_issues | failed
    t.integer('default_doctor_id').unsigned().nullable(); // a doctor of the receiving clinic (no FK: other database)
    t.integer('total').notNullable().defaultTo(0);
    t.integer('done').notNullable().defaultTo(0);
    t.integer('failed').notNullable().defaultTo(0);
    t.text('report').nullable(); // JSON counts: visits, files, future bookings left…
    t.string('error', 255).nullable();
    t.string('locale', 5).nullable();
    t.string('runner', 40).nullable();
    t.timestamp('heartbeat_at').nullable();
    t.timestamp('started_at').nullable();
    t.timestamp('finished_at').nullable();
    t.timestamps(true, true);
    t.index(['status'], 'ptransfers_status_idx');
    t.index(['from_business_id'], 'ptransfers_from_idx');
    t.index(['to_business_id'], 'ptransfers_to_idx');
  });
  await knex.schema.createTable('patient_transfer_items', (t) => {
    t.increments('id').primary();
    t.integer('transfer_id').unsigned().notNullable().references('patient_transfers.id').onDelete('CASCADE');
    t.integer('src_patient_id').unsigned().notNullable();
    t.integer('dst_patient_id').unsigned().nullable();
    t.string('name', 190).nullable();
    t.string('status', 12).notNullable().defaultTo('pending'); // pending | done | failed
    t.integer('future_bookings').notNullable().defaultTo(0);
    t.string('message', 255).nullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.unique(['transfer_id', 'src_patient_id'], { indexName: 'ptitems_uq' });
    t.index(['transfer_id', 'status'], 'ptitems_status_idx');
  });
  await knex.schema.createTable('patient_links', (t) => {
    t.increments('id').primary();
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().notNullable();
    t.integer('other_business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('other_patient_id').unsigned().notNullable();
    t.string('kind', 12).notNullable(); // shared | moved_to | moved_from
    t.integer('transfer_id').unsigned().nullable();
    t.timestamp('last_synced_at').nullable();
    t.timestamps(true, true);
    t.unique(['business_id', 'patient_id', 'other_business_id'], { indexName: 'plinks_uq' });
    t.index(['other_business_id', 'other_patient_id'], 'plinks_other_idx');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('patient_links');
  await knex.schema.dropTableIfExists('patient_transfer_items');
  await knex.schema.dropTableIfExists('patient_transfers');
  for (const c of ['transferred_at', 'transferred_patient_id', 'transferred_to_business_id']) { // eslint-disable-line no-restricted-syntax
    if (await knex.schema.hasColumn('patients', c)) await knex.schema.alterTable('patients', (t) => { t.dropColumn(c); }); // eslint-disable-line no-await-in-loop
  }
};
