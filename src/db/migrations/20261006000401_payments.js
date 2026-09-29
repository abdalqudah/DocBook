// Online payments (pay before confirmation) and documents shared with the patient.
//  • payment_gateways: one row per clinic — the card gateway it uses (none | paytabs | hyperpay), test or live,
//    the merchant credentials encrypted with APP_KEY (src/core/secrets.js), and how long an online booking that
//    waits for payment keeps its slot (minutes; 0 = never released automatically).
//  • payments: one row per payment attempt of an appointment. The provider's references and the verified result
//    (no card data — the card is only ever typed on the provider's page). `public_id` is the unguessable id used in
//    the return/callback addresses. `invoice_id` is set once the verified payment was turned into an invoice, so a
//    second callback can never create a second invoice.
//  • patient_documents: which documents of a visit the doctor sent to the patient (prescription, consultation
//    report, medical certificate) — shown on the patient's consultation page and e-mailed; the PDF itself is
//    generated on demand from the clinical record, so it always matches what the clinic has on file.
exports.up = async (knex) => {
  await knex.schema.createTable('payment_gateways', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('provider', 12).notNullable().defaultTo('none'); // none | paytabs | hyperpay
    t.string('mode', 8).notNullable().defaultTo('test');      // test | live
    t.text('credentials_enc');
    t.integer('hold_minutes').notNullable().defaultTo(30);
    t.timestamp('tested_at').nullable();
    t.boolean('test_ok').nullable();
    t.integer('updated_by').unsigned().nullable();
    t.timestamps(true, true);
    t.unique(['business_id'], 'pg_business_uq');
  });
  await knex.schema.createTable('payments', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().notNullable().references('appointments.id').onDelete('CASCADE');
    t.string('public_id', 40).notNullable();
    t.string('provider', 12).notNullable();
    t.string('mode', 8).notNullable().defaultTo('test');
    t.string('brand', 12).nullable();                 // card | mada (HyperPay entity)
    t.string('cart_id', 60).notNullable();            // our reference sent to the provider (cart_id / merchantTransactionId)
    t.decimal('amount', 15, 3).notNullable();
    t.string('currency', 3).notNullable();
    t.string('status', 12).notNullable().defaultTo('initiated'); // initiated | paid | failed | cancelled | refunded
    t.string('provider_ref', 120).nullable();         // PayTabs tran_ref / HyperPay checkout id
    t.string('provider_payment_id', 120).nullable();  // HyperPay payment id (refunds) / PayTabs tran_ref
    t.string('result_code', 40).nullable();
    t.string('result_message', 255).nullable();
    t.text('raw_result');                             // the provider's verified answer, card fields removed
    t.string('note', 40).nullable();                  // duplicate | late (paid but the booking was already paid/cancelled)
    t.integer('invoice_id').unsigned().nullable();
    t.decimal('refunded_amount', 15, 3).nullable();
    t.string('refund_ref', 120).nullable();
    t.timestamp('paid_at').nullable();
    t.timestamp('refunded_at').nullable();
    t.integer('refunded_by').unsigned().nullable();
    t.timestamps(true, true);
    t.unique(['public_id'], 'pay_public_uq');
    t.index(['business_id', 'appointment_id'], 'pay_appt_idx');
    t.index(['status', 'created_at'], 'pay_status_idx');
  });
  await knex.schema.createTable('patient_documents', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().notNullable().references('appointments.id').onDelete('CASCADE');
    t.string('kind', 20).notNullable();   // prescription | report | certificate
    t.integer('ref_id').unsigned().nullable(); // prescription id / certificate id (report: the visit itself)
    t.text('options');                    // report: the sections the doctor chose to include (JSON)
    t.string('locale', 5).notNullable().defaultTo('ar');
    t.integer('shared_by').unsigned().nullable();
    t.timestamp('emailed_at').nullable();
    t.timestamp('revoked_at').nullable();
    t.integer('downloads').unsigned().notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.index(['business_id', 'appointment_id'], 'pdoc_appt_idx');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('patient_documents');
  await knex.schema.dropTableIfExists('payments');
  await knex.schema.dropTableIfExists('payment_gateways');
};
