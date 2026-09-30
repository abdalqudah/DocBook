// "Finish visit" by the doctor (round 8, doctor journey): the doctor enters what reception must collect.
//   appointments.doctor_lines        JSON [{ name, name_en, service_id, qty, unit_price }] — the bill lines the doctor set
//                                     (the booked service / consultation with its price, plus extra services). amount_due
//                                     holds their total. NULL = the doctor did not set a bill (the cashier keeps its default).
//   appointments.doctor_finished_at  when the doctor pressed "Finish visit & send to reception" (last time)
//   appointments.doctor_finished_by  who pressed it (users.id)
exports.up = async (knex) => {
  await knex.schema.alterTable('appointments', (t) => {
    t.json('doctor_lines').nullable();
    t.timestamp('doctor_finished_at').nullable();
    t.integer('doctor_finished_by').unsigned().nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('appointments', (t) => {
    t.dropColumn('doctor_lines');
    t.dropColumn('doctor_finished_at');
    t.dropColumn('doctor_finished_by');
  });
};
