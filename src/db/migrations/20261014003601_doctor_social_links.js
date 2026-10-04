// A doctor's social-media profiles (Facebook, Instagram, X, LinkedIn, YouTube, TikTok, Snapchat, own website) as JSON,
// shown on the doctor's card and page of the clinic website (see modules/clinic/doctor-social.js).
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('doctors', 'social_links'))) await knex.schema.alterTable('doctors', (t) => { t.text('social_links').nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('doctors', 'social_links')) await knex.schema.alterTable('doctors', (t) => { t.dropColumn('social_links'); });
};
