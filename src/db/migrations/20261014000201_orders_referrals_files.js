// Clinical orders and the patient's file:
//   • order_catalog — the clinic's list of lab tests and imaging studies (editable; a starter list can be added);
//   • medical_orders — a lab or imaging request written during a visit (printable on the clinic's letterhead), with its
//     status (ordered → done / cancelled) and a result note;
//   • referrals — a referral letter to a specialist (printable on the letterhead);
//   • patient_files — scanned paper forms, lab results, imaging reports … stored with the patient (optionally linked to
//     a visit or an order); kept in the database like the other clinic files;
//   • clinic_messaging.cancellations_enabled / wa_tpl_cancelled — tell the patient when the clinic cancels.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('order_catalog'))) {
    await knex.schema.createTable('order_catalog', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('kind', 10).notNullable(); // lab | imaging
      t.string('name', 160).notNullable();
      t.string('name_en', 160);
      t.string('code', 40);
      t.string('category', 80);
      t.boolean('is_active').notNullable().defaultTo(true);
      t.integer('sort_order').notNullable().defaultTo(0);
      t.timestamps(true, true);
      t.unique(['business_id', 'kind', 'name']);
      t.index(['business_id', 'kind', 'is_active']);
    });
  }
  if (!(await knex.schema.hasTable('medical_orders'))) {
    await knex.schema.createTable('medical_orders', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('patient_id').unsigned().nullable().references('patients.id').onDelete('SET NULL');
      t.integer('appointment_id').unsigned().nullable().references('appointments.id').onDelete('SET NULL');
      t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
      t.string('kind', 10).notNullable(); // lab | imaging
      t.json('items').notNullable(); // [{ name, code }]
      t.string('urgency', 10).notNullable().defaultTo('routine'); // routine | urgent
      t.text('notes');
      t.string('status', 12).notNullable().defaultTo('ordered'); // ordered | done | cancelled
      t.text('result_note');
      t.timestamp('done_at').nullable();
      t.string('patient_name', 191);
      t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
      t.timestamps(true, true);
      t.index(['business_id', 'patient_id']);
      t.index(['business_id', 'status']);
    });
  }
  if (!(await knex.schema.hasTable('referrals'))) {
    await knex.schema.createTable('referrals', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('patient_id').unsigned().nullable().references('patients.id').onDelete('SET NULL');
      t.integer('appointment_id').unsigned().nullable().references('appointments.id').onDelete('SET NULL');
      t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
      t.string('specialty', 120).notNullable();
      t.string('to_doctor', 160);
      t.string('to_facility', 160);
      t.string('urgency', 10).notNullable().defaultTo('routine');
      t.text('reason').notNullable();
      t.text('summary');
      t.string('patient_name', 191);
      t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
      t.timestamps(true, true);
      t.index(['business_id', 'patient_id']);
    });
  }
  if (!(await knex.schema.hasTable('patient_files'))) {
    await knex.schema.createTable('patient_files', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
      t.integer('appointment_id').unsigned().nullable().references('appointments.id').onDelete('SET NULL');
      t.integer('order_id').unsigned().nullable().references('medical_orders.id').onDelete('SET NULL');
      t.string('category', 20).notNullable().defaultTo('scan'); // scan | lab_result | imaging | report | other
      t.string('title', 160);
      t.string('name', 160).notNullable();
      t.string('mime', 60).notNullable();
      t.integer('size').unsigned().notNullable();
      t.string('sha256', 64).notNullable();
      t.specificType('data', 'MEDIUMBLOB').notNullable();
      t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['business_id', 'patient_id']);
    });
  }
  if (!(await knex.schema.hasColumn('clinic_messaging', 'cancellations_enabled'))) {
    await knex.schema.alterTable('clinic_messaging', (t) => {
      t.boolean('cancellations_enabled').notNullable().defaultTo(true);
      t.string('wa_tpl_cancelled', 120).nullable();
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('clinic_messaging', 'cancellations_enabled')) {
    await knex.schema.alterTable('clinic_messaging', (t) => { t.dropColumn('cancellations_enabled'); t.dropColumn('wa_tpl_cancelled'); });
  }
  await knex.schema.dropTableIfExists('patient_files');
  await knex.schema.dropTableIfExists('referrals');
  await knex.schema.dropTableIfExists('medical_orders');
  await knex.schema.dropTableIfExists('order_catalog');
};
