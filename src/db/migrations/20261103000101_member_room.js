// Assistants and nurses belong to a clinic (room / chair) number — the doctors move between rooms, the assistant stays:
// memberships.room. Shown beside the room on the calendar and the front desk; a member with a room opens the front
// desk on the doctor working in that room today.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('memberships', 'room'))) await knex.schema.alterTable('memberships', (t) => { t.string('room', 20).nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('memberships', 'room')) await knex.schema.alterTable('memberships', (t) => { t.dropColumn('room'); });
};
