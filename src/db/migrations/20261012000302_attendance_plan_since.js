// Staff attendance: the day the clinic started tracking working hours. Days before it are never counted as
// absences (setting hours today must not mark everyone absent for the past weeks). Additive only.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('attendance_settings', 'plan_since'))) {
    await knex.schema.alterTable('attendance_settings', (t) => { t.date('plan_since').nullable(); });
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('attendance_settings', 'plan_since')) await knex.schema.alterTable('attendance_settings', (t) => { t.dropColumn('plan_since'); });
};
