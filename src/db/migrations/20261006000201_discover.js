// Clinic discovery & booking channels:
//  • businesses.directory_listed — the clinic opted in to the shared DocBook directory (/clinics). Off by default.
//  • businesses.widget_origins — optional list of websites (one origin per line) allowed to embed the booking
//    widget; empty = any website may embed the booking page (only the embed variant is ever frameable).
//  • appointments.booking_channel — where a booking came from: staff, website, directory, widget, instagram,
//    facebook, google, whatsapp, qr, x. Existing rows are back-filled from appointments.source.
exports.up = async (knex) => {
  await knex.schema.alterTable('businesses', (t) => {
    t.boolean('directory_listed').notNullable().defaultTo(false);
    t.text('widget_origins').nullable();
  });
  await knex.schema.alterTable('appointments', (t) => {
    t.string('booking_channel', 20).nullable();
    t.index(['business_id', 'booking_channel'], 'appt_channel_idx');
  });
  await knex('appointments').whereNull('booking_channel').update({ booking_channel: knex.raw("CASE WHEN source = 'website' THEN 'website' ELSE 'staff' END") });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('appointments', (t) => {
    t.dropIndex(['business_id', 'booking_channel'], 'appt_channel_idx');
    t.dropColumn('booking_channel');
  });
  await knex.schema.alterTable('businesses', (t) => {
    t.dropColumn('directory_listed');
    t.dropColumn('widget_origins');
  });
};
