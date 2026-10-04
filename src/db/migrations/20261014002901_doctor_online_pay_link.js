// A doctor's own online-payment link for online consultations (a PayTabs / bank / wallet payment page of their
// choice), shown to the patient with the consultation price. The doctor manages it from "My online consultations".
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('doctors', 'online_pay_link'))) await knex.schema.alterTable('doctors', (t) => { t.string('online_pay_link', 500).nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('doctors', 'online_pay_link')) await knex.schema.alterTable('doctors', (t) => { t.dropColumn('online_pay_link'); });
};
