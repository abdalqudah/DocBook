// A doctor's photo, chosen from the clinic media library (shown on the public clinic page, booking page and staff screens).
// Deleting the library image clears it (SET NULL); the library tracks the use in media_usages ('doctor.photo', ref_id = doctor).
exports.up = async (knex) => {
  await knex.schema.alterTable('doctors', (t) => {
    t.integer('photo_media_id').unsigned().nullable().references('clinic_media.id').onDelete('SET NULL');
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('doctors', (t) => { t.dropForeign('photo_media_id'); t.dropColumn('photo_media_id'); });
};
