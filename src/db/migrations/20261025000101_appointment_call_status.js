// The outcome of the reception's call about an appointment (as Clinica had it): "no answer" or "call back" (recall).
// Beside the status (the booking still holds its time), with who set it and when.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('appointments', 'call_status'))) {
    await knex.schema.alterTable('appointments', (t) => {
      t.string('call_status', 12).nullable(); // no_answer | recall
      t.timestamp('call_status_at').nullable();
      t.integer('call_status_by').unsigned().nullable();
    });
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('appointments', 'call_status')) {
    await knex.schema.alterTable('appointments', (t) => { t.dropColumn('call_status'); t.dropColumn('call_status_at'); t.dropColumn('call_status_by'); });
  }
};
