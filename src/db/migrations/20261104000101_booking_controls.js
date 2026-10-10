// Who patients can book online, and who the website shows:
//   doctors.online_booking   the doctor takes online bookings (active doctors may not)
//   doctors.show_on_site     the doctor is shown on the clinic's website
//   businesses.booking_clinic_only   online bookings go to the clinic without a doctor: reception chooses the doctor,
//                                    confirms, and the patient is told (no doctor choice on the booking page)
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('doctors', 'online_booking'))) await knex.schema.alterTable('doctors', (t) => { t.boolean('online_booking').notNullable().defaultTo(true); });
  if (!(await knex.schema.hasColumn('doctors', 'show_on_site'))) await knex.schema.alterTable('doctors', (t) => { t.boolean('show_on_site').notNullable().defaultTo(true); });
  if (!(await knex.schema.hasColumn('businesses', 'booking_clinic_only'))) await knex.schema.alterTable('businesses', (t) => { t.boolean('booking_clinic_only').notNullable().defaultTo(false); });
};
exports.down = async (knex) => {
  for (const [t, c] of [['doctors', 'online_booking'], ['doctors', 'show_on_site'], ['businesses', 'booking_clinic_only']]) { // eslint-disable-line no-restricted-syntax
    if (await knex.schema.hasColumn(t, c)) await knex.schema.alterTable(t, (x) => { x.dropColumn(c); }); // eslint-disable-line no-await-in-loop
  }
};
