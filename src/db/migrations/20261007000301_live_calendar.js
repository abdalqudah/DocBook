// Live agenda + calendar import/export (worker: live).
//  • appointments.external_source / external_uid — appointments imported from an iCal file or URL (Google Calendar,
//    Outlook, Apple). external_uid is the event UID (one occurrence of a recurring event: UID@YYYYMMDD);
//    unique per clinic so the same event is never imported twice. Imported rows have source = 'import'.
//  • calendar_feeds — one private iCal subscription address per doctor (/calendar/<token>.ics). Only the hash is
//    looked up; the token itself is kept encrypted so the address can be shown again. Deleting the row = feed off.
exports.up = async (knex) => {
  await knex.schema.alterTable('appointments', (t) => {
    t.string('external_source', 20).nullable();
    t.string('external_uid', 190).nullable();
    t.unique(['business_id', 'external_uid'], { indexName: 'appointments_business_external_uid_unique' });
  });
  await knex.schema.createTable('calendar_feeds', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().notNullable().references('doctors.id').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique();
    t.text('token_enc').notNullable();
    t.string('locale', 2).notNullable().defaultTo('ar');
    t.integer('created_by').unsigned().nullable();
    t.timestamp('last_used_at').nullable();
    t.timestamps(true, true);
    t.unique(['business_id', 'doctor_id']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('calendar_feeds');
  await knex.schema.alterTable('appointments', (t) => {
    t.dropUnique(['business_id', 'external_uid'], 'appointments_business_external_uid_unique');
    t.dropColumn('external_uid');
    t.dropColumn('external_source');
  });
};
