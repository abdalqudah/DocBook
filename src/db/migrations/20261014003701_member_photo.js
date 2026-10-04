// A team member's own photo (uploaded from Settings → My account into the clinic's media library). A doctor's
// account also sets the doctor's photo (website, booking page, staff screens). No foreign key: the media library
// may live in the clinic's own database.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('memberships', 'photo_media_id'))) await knex.schema.alterTable('memberships', (t) => { t.integer('photo_media_id').unsigned().nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('memberships', 'photo_media_id')) await knex.schema.alterTable('memberships', (t) => { t.dropColumn('photo_media_id'); });
};
