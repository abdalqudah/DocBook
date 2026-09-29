// Patient engagement: WhatsApp / SMS / e-mail appointment messages and verified reviews.
//  • patients.messaging_opt_out(_at): the patient replied STOP or used the opt-out link — no automated message
//    (confirmation, reminder, review request) is sent to them any more.
//  • clinic_messaging: one row per clinic — on/off switches, reminder offsets (minutes before), channels, the
//    WhatsApp Cloud API credentials (access token and webhook app secret encrypted with src/core/secrets),
//    template names, a generic HTTP SMS provider, patient self-service rules and the review request delay.
//  • appointment_links: the patient's secret links — /r/<token> (confirm / cancel / reschedule) and
//    /review/<token>. The database keeps the SHA-256 (look-ups) and the token encrypted (so the next message
//    can repeat the same link) — never the token in clear. One link per appointment and purpose.
//  • message_dispatches: one row per appointment + stage + slot (the "claim"): the unique key makes sending
//    idempotent even with several app processes; a moved appointment (other slot) gets its own reminders.
//  • message_log: one row per channel attempt (status and provider id, never the message text).
//  • reviews: one verified review per visited appointment; clinics reply once and may report; only the platform
//    hides (with a reason). Nobody edits or deletes a patient's words.
exports.up = async (knex) => {
  await knex.schema.alterTable('patients', (t) => {
    t.boolean('messaging_opt_out').notNullable().defaultTo(false);
    t.timestamp('messaging_opt_out_at').nullable();
  });
  await knex.schema.createTable('clinic_messaging', (t) => {
    t.integer('business_id').unsigned().primary().references('businesses.id').onDelete('CASCADE');
    t.boolean('confirmations_enabled').notNullable().defaultTo(true);
    t.boolean('reminders_enabled').notNullable().defaultTo(true);
    t.json('reminder_offsets'); // minutes before the start, e.g. [1440, 120]
    t.boolean('reviews_enabled').notNullable().defaultTo(true);
    t.integer('review_delay_minutes').notNullable().defaultTo(120);
    t.boolean('use_whatsapp').notNullable().defaultTo(true);
    t.boolean('use_sms').notNullable().defaultTo(false);
    t.boolean('use_email').notNullable().defaultTo(true);
    t.string('message_locale', 2).notNullable().defaultTo('ar');
    t.string('default_dial', 4); // country calling code for local numbers (0791234567 → 962791234567)
    // WhatsApp Cloud API
    t.string('wa_phone_number_id', 40);
    t.text('wa_token_enc');
    t.string('wa_tpl_confirmation', 120);
    t.string('wa_tpl_reminder', 120);
    t.string('wa_tpl_review', 120);
    t.string('wa_lang_ar', 10).notNullable().defaultTo('ar');
    t.string('wa_lang_en', 10).notNullable().defaultTo('en');
    t.boolean('wa_quick_confirm').notNullable().defaultTo(false); // the reminder template starts with a "Confirm" quick-reply button
    t.string('wa_hook_key', 43); // public part of the webhook URL /hooks/whatsapp/<key>
    t.text('wa_app_secret_enc'); // X-Hub-Signature-256 check
    t.string('wa_verify_token', 64);
    t.timestamp('wa_verified_at').nullable();
    t.string('wa_last_error', 255);
    // Generic HTTP SMS provider
    t.string('sms_url', 500);
    t.string('sms_method', 6).notNullable().defaultTo('POST');
    t.string('sms_content_type', 60).notNullable().defaultTo('application/json');
    t.text('sms_body_template');
    t.string('sms_auth_header', 60);
    t.text('sms_auth_enc');
    t.string('sms_inbound_key', 43);
    // Patient self-service on /r/<token>
    t.integer('cancel_cutoff_hours').notNullable().defaultTo(3);
    t.boolean('allow_reschedule').notNullable().defaultTo(true);
    t.integer('updated_by').unsigned().nullable();
    t.timestamps(true, true);
    t.unique(['wa_hook_key'], 'cm_wa_hook_uq');
    t.unique(['sms_inbound_key'], 'cm_sms_hook_uq');
  });
  await knex.schema.createTable('appointment_links', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().notNullable().references('appointments.id').onDelete('CASCADE');
    t.string('purpose', 10).notNullable(); // action | review
    t.string('token_hash', 64).notNullable();
    t.text('token_enc').notNullable();
    t.datetime('expires_at').nullable(); // review links: 30 days; action links expire with the appointment itself
    t.datetime('used_at').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['appointment_id', 'purpose'], 'al_appt_purpose_uq');
    t.unique(['token_hash'], 'al_token_uq');
    t.index(['business_id']);
  });
  await knex.schema.createTable('message_dispatches', (t) => {
    t.bigIncrements('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().notNullable().references('appointments.id').onDelete('CASCADE');
    t.string('stage', 20).notNullable(); // confirmation | reminder_<minutes> | review
    t.string('slot_key', 20).notNullable(); // 'YYYY-MM-DD HH:MM' of the appointment when claimed
    t.string('status', 12).notNullable().defaultTo('claimed'); // claimed | sent | failed | opted_out | skipped
    t.datetime('claimed_at').notNullable();
    t.datetime('finished_at').nullable();
    t.unique(['appointment_id', 'stage', 'slot_key'], 'md_claim_uq');
    t.index(['business_id', 'claimed_at'], 'md_business_idx');
  });
  await knex.schema.createTable('message_log', (t) => {
    t.bigIncrements('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().nullable();
    t.bigInteger('dispatch_id').unsigned().nullable();
    t.string('stage', 20).notNullable(); // confirmation | reminder_<m> | review | test | manual | opt_out
    t.string('channel', 10).notNullable(); // whatsapp | sms | email | link
    t.string('recipient', 24); // masked
    t.string('status', 12).notNullable(); // sent | failed | opted_out | received
    t.string('provider_id', 120);
    t.string('error', 255);
    t.integer('user_id').unsigned().nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'id'], 'ml_business_idx');
    t.index(['provider_id'], 'ml_provider_idx');
  });
  await knex.schema.createTable('reviews', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().nullable().references('appointments.id').onDelete('SET NULL'); // deleting the visit keeps the review
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
    t.integer('patient_id').unsigned().nullable();
    t.tinyint('rating').unsigned().notNullable();
    t.tinyint('rating_doctor').unsigned().nullable();
    t.tinyint('rating_wait').unsigned().nullable();
    t.tinyint('rating_clinic').unsigned().nullable();
    t.text('comment');
    t.string('locale', 2).notNullable().defaultTo('ar');
    t.string('display_mode', 10).notNullable().defaultTo('initials'); // full | initials | anonymous
    t.string('display_name', 120);
    t.date('visit_date').notNullable();
    t.string('status', 10).notNullable().defaultTo('published'); // published | hidden
    t.string('hidden_reason', 500);
    t.integer('hidden_by').unsigned().nullable();
    t.datetime('hidden_at').nullable();
    t.datetime('reported_at').nullable();
    t.string('report_reason', 500);
    t.integer('reported_by').unsigned().nullable();
    t.text('reply');
    t.integer('reply_by').unsigned().nullable();
    t.datetime('replied_at').nullable();
    t.string('ip_hash', 64);
    t.timestamps(true, true);
    t.unique(['appointment_id'], 'rv_appt_uq');
    t.index(['business_id', 'status', 'created_at'], 'rv_business_idx');
    t.index(['doctor_id']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('reviews');
  await knex.schema.dropTableIfExists('message_log');
  await knex.schema.dropTableIfExists('message_dispatches');
  await knex.schema.dropTableIfExists('appointment_links');
  await knex.schema.dropTableIfExists('clinic_messaging');
  await knex.schema.alterTable('patients', (t) => { t.dropColumn('messaging_opt_out'); t.dropColumn('messaging_opt_out_at'); });
};
