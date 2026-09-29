// Purchase order workflow details:
//  • po_number is claimed when the order is sent (drafts have none yet), so it becomes nullable
//    (the unique (business_id, po_number) index still guards sent orders; NULLs don't collide).
//  • the person who sent it (contact for the supplier) is kept as a snapshot.
//  • a registered vendor can confirm the order and leave a short note for the clinic.
//  • cancelled_at completes the status timeline.
exports.up = async (knex) => {
  await knex.schema.alterTable('purchase_orders', (t) => {
    t.integer('po_number').unsigned().nullable().alter();
    t.integer('sent_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('contact_name', 190);
    t.string('contact_phone', 40);
    t.string('contact_email', 190);
    t.text('vendor_note');
    t.timestamp('vendor_noted_at').nullable();
    t.timestamp('cancelled_at').nullable();
  });
};

exports.down = async (knex) => {
  await knex('purchase_orders').whereNull('po_number').del();
  await knex.schema.alterTable('purchase_orders', (t) => {
    t.dropForeign('sent_by');
    t.dropColumn('sent_by');
    t.dropColumn('contact_name');
    t.dropColumn('contact_phone');
    t.dropColumn('contact_email');
    t.dropColumn('vendor_note');
    t.dropColumn('vendor_noted_at');
    t.dropColumn('cancelled_at');
  });
  await knex.schema.alterTable('purchase_orders', (t) => { t.integer('po_number').unsigned().notNullable().alter(); });
};
