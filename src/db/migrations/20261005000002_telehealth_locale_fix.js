// Databases that ran an early version of 20261005000001_telehealth lack online_consultations.locale
// (the language of the patient's e-mails). Adds it only when missing.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('online_consultations', 'locale'))) {
    await knex.schema.alterTable('online_consultations', (t) => { t.string('locale', 5).notNullable().defaultTo('ar'); });
  }
};
exports.down = async () => {};
