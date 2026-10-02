// Secure links to send a document to a patient (by WhatsApp or any message): invoice, prescription, consultation report,
// medical certificate / sick leave, lab or imaging order, referral letter, or a file from the patient's file (imaging,
// results). Only a hash of the token is stored; a link expires, can be withdrawn, and every opening is counted.
exports.up = async (knex) => {
  if (await knex.schema.hasTable('share_links')) return;
  await knex.schema.createTable('share_links', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique();
    t.string('kind', 16).notNullable(); // invoice | prescription | report | certificate | order | referral | file
    t.integer('ref_id').unsigned().notNullable();
    t.integer('appointment_id').unsigned().nullable();
    t.integer('patient_id').unsigned().nullable();
    t.text('options');
    t.string('locale', 2).notNullable().defaultTo('ar');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at').notNullable();
    t.timestamp('revoked_at').nullable();
    t.integer('opens').unsigned().notNullable().defaultTo(0);
    t.timestamp('last_opened_at').nullable();
    t.index(['business_id', 'kind', 'ref_id']);
  });
};
exports.down = (knex) => knex.schema.dropTableIfExists('share_links');
