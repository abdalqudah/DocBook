// A doctor's full profile for the website (JSON): years of experience, languages, career, professional memberships and
// areas of focus — each text in Arabic and English (see modules/clinic/doctor-profile.js). Education stays in its columns.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('doctors', 'profile'))) await knex.schema.alterTable('doctors', (t) => { t.text('profile').nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('doctors', 'profile')) await knex.schema.alterTable('doctors', (t) => { t.dropColumn('profile'); });
};
