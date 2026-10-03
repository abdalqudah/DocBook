// Pharmacies, imaging centres and laboratories the clinic works with (outside, or inside the clinic itself), the
// papers sent to them (prescriptions, lab / imaging requests) and, for a request, which centre it went to.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('clinic_partners'))) {
    await knex.schema.createTable('clinic_partners', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('kind', 10).notNullable(); // pharmacy | imaging | lab
      t.string('name', 120).notNullable();
      t.string('phone', 40).nullable(); // WhatsApp / phone
      t.string('email', 190).nullable();
      t.string('address', 255).nullable();
      t.boolean('in_house').notNullable().defaultTo(false); // inside the clinic: requests go to its list in DocBook
      t.boolean('is_active').notNullable().defaultTo(true);
      t.string('notes', 500).nullable();
      t.timestamps(true, true);
      t.index(['business_id', 'kind']);
    });
  }
  if (!(await knex.schema.hasTable('partner_sends'))) {
    await knex.schema.createTable('partner_sends', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('partner_id').unsigned().notNullable().references('clinic_partners.id').onDelete('CASCADE');
      t.string('doc_kind', 15).notNullable(); // prescription | order
      t.integer('doc_id').unsigned().notNullable();
      t.integer('appointment_id').unsigned().nullable();
      t.string('patient_name', 191).nullable();
      t.string('channel', 10).notNullable(); // whatsapp | email | in_house
      t.integer('share_link_id').unsigned().nullable();
      t.string('status', 12).notNullable().defaultTo('sent'); // sent | received | done
      t.integer('sent_by').unsigned().nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['business_id', 'partner_id']);
      t.index(['business_id', 'doc_kind', 'doc_id']);
    });
  }
  if (!(await knex.schema.hasColumn('medical_orders', 'partner_id'))) await knex.schema.alterTable('medical_orders', (t) => { t.integer('partner_id').unsigned().nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('medical_orders', 'partner_id')) await knex.schema.alterTable('medical_orders', (t) => { t.dropColumn('partner_id'); });
  await knex.schema.dropTableIfExists('partner_sends');
  await knex.schema.dropTableIfExists('clinic_partners');
};
