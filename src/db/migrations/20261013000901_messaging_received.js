// WhatsApp template for "we received your booking request" (online bookings waiting for the clinic's confirmation).
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('clinic_messaging', 'wa_tpl_received'))) await knex.schema.alterTable('clinic_messaging', (t) => { t.string('wa_tpl_received', 120).nullable(); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('clinic_messaging', 'wa_tpl_received')) await knex.schema.alterTable('clinic_messaging', (t) => { t.dropColumn('wa_tpl_received'); });
};
