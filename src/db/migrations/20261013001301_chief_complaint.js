// Chief complaint ("what brings the patient in"): written at reception or by the nurse while the patient waits, next
// to the vital signs; the doctor sees it at the top of the visit. Separate from the doctor's SOAP note.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('consultations', 'chief_complaint'))) await knex.schema.alterTable('consultations', (t) => { t.text('chief_complaint').nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('consultations', 'chief_complaint')) await knex.schema.alterTable('consultations', (t) => { t.dropColumn('chief_complaint'); });
};
