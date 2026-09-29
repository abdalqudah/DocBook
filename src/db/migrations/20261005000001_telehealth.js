// Online consultations (telehealth): a patient — often abroad — books a video consultation with a doctor.
//  • doctors.online_*: the doctor offers online consultations, its fee (NULL = consultation fee), its length
//    (NULL = the doctor's slot length) and the video method: builtin (WebRTC in the browser), jitsi (JITSI_URL)
//    or link (the doctor's own https meeting link).
//  • doctor_online_slots: optional weekly windows for online consultations. None = the doctor's working hours.
//    Online and in-clinic appointments share the doctor's calendar, so they can never overlap.
//  • businesses.online_*: the clinic turns online consultations on, may require payment before confirmation
//    (bank transfer / CliQ… — staff mark it paid), with payment instructions and a cancellation policy (AR/EN).
//  • online_consultations: one row per online appointment — the secret link (hash for look-ups, the token itself
//    encrypted with APP_KEY so staff can copy it again), the patient's time zone and country, the reason, whether
//    payment was required when booking, e-mail timestamps and who joined when.
//  • online_consultation_files: files the patient attached (PDF/JPEG/PNG ≤ 10 MB, MEDIUMBLOB holds up to 16 MB);
//    only clinic staff with clinical.view can open them — never public.
//  • telehealth_signals: WebRTC signaling messages (offer/answer/ICE…) exchanged through the server by polling.
//    Kept in the database so a call survives a restart or several app processes; purged after a day.
exports.up = async (knex) => {
  await knex.schema.alterTable('doctors', (t) => {
    t.boolean('online_enabled').notNullable().defaultTo(false);
    t.decimal('online_fee', 15, 3).nullable();
    t.integer('online_duration_minutes').nullable();
    t.string('online_method', 10).notNullable().defaultTo('builtin'); // builtin | jitsi | link
    t.string('online_link', 500).nullable();
  });
  await knex.schema.createTable('doctor_online_slots', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().notNullable().references('doctors.id').onDelete('CASCADE');
    t.string('weekday', 3).notNullable(); // sun … sat
    t.string('start_time', 5).notNullable();
    t.string('end_time', 5).notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['business_id', 'doctor_id']);
  });
  await knex.schema.alterTable('businesses', (t) => {
    t.boolean('online_enabled').notNullable().defaultTo(false);
    t.boolean('online_payment_required').notNullable().defaultTo(false);
    t.text('online_payment_instructions');
    t.text('online_payment_instructions_en');
    t.text('online_cancellation_policy');
    t.text('online_cancellation_policy_en');
  });
  await knex.schema.createTable('online_consultations', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('appointment_id').unsigned().notNullable().references('appointments.id').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable();
    t.text('token_enc').notNullable();
    t.string('patient_timezone', 64);
    t.string('patient_country', 2);
    t.string('locale', 5).notNullable().defaultTo('ar'); // language of the patient's e-mails
    t.text('reason');
    t.boolean('payment_required').notNullable().defaultTo(false);
    t.timestamp('received_sent_at').nullable();
    t.timestamp('link_sent_at').nullable();
    t.timestamp('reminder_sent_at').nullable();
    t.timestamp('cancel_sent_at').nullable();
    t.timestamp('patient_joined_at').nullable();
    t.timestamp('patient_seen_at').nullable();
    t.timestamp('doctor_joined_at').nullable();
    t.timestamp('doctor_seen_at').nullable();
    t.timestamps(true, true);
    t.unique(['appointment_id'], 'oc_appointment_uq');
    t.unique(['token_hash'], 'oc_token_uq');
    t.index(['business_id']);
  });
  await knex.schema.createTable('online_consultation_files', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('consultation_id').unsigned().notNullable().references('online_consultations.id').onDelete('CASCADE');
    t.string('name', 160).notNullable();
    t.string('mime', 40).notNullable();
    t.integer('size').unsigned().notNullable();
    t.string('sha256', 64).notNullable();
    t.specificType('data', 'MEDIUMBLOB').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['consultation_id']);
  });
  await knex.schema.createTable('telehealth_signals', (t) => {
    t.bigIncrements('id');
    t.integer('consultation_id').unsigned().notNullable().references('online_consultations.id').onDelete('CASCADE');
    t.string('sender', 10).notNullable(); // patient | doctor
    t.string('kind', 10).notNullable();   // hello | ready | offer | answer | ice | bye
    t.specificType('payload', 'MEDIUMTEXT');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['consultation_id', 'id'], 'ts_consult_idx');
    t.index(['created_at'], 'ts_created_idx');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('telehealth_signals');
  await knex.schema.dropTableIfExists('online_consultation_files');
  await knex.schema.dropTableIfExists('online_consultations');
  await knex.schema.dropTableIfExists('doctor_online_slots');
  await knex.schema.alterTable('businesses', (t) => {
    ['online_enabled', 'online_payment_required', 'online_payment_instructions', 'online_payment_instructions_en', 'online_cancellation_policy', 'online_cancellation_policy_en'].forEach((c) => t.dropColumn(c));
  });
  await knex.schema.alterTable('doctors', (t) => {
    ['online_enabled', 'online_fee', 'online_duration_minutes', 'online_method', 'online_link'].forEach((c) => t.dropColumn(c));
  });
};
