// AI clinical assistant ("second opinion" for doctors, powered by Claude).
//  • ai_clinic_settings: one row per clinic — opt-in (off by default), who acknowledged the data-processing notice
//    and when, and which roles may use the assistant (role keys, JSON array; default ["doctor"]).
//  • ai_requests: one row per request sent (or attempted) — who, which visit, which action, model, token usage,
//    outcome and the structured result (JSON) so reopening the visit shows the last answer. No patient identifiers
//    are stored here beyond the appointment id; the de-identified input text is not stored.
// Platform-wide switch, API key (encrypted with APP_KEY), model and caps live in platform_settings (key "ai").
exports.up = async (knex) => {
  await knex.schema.createTable('ai_clinic_settings', (t) => {
    t.integer('business_id').unsigned().primary().references('businesses.id').onDelete('CASCADE');
    t.boolean('enabled').notNullable().defaultTo(false);
    t.json('allowed_roles').nullable();
    t.timestamp('acknowledged_at').nullable();
    t.integer('acknowledged_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('ai_requests', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('appointment_id').unsigned().nullable().references('appointments.id').onDelete('SET NULL');
    t.string('kind', 20).notNullable();                 // summary | second_opinion | rx_check
    t.string('model', 80).nullable();
    t.string('locale', 2).notNullable().defaultTo('ar');
    t.integer('input_tokens').unsigned().notNullable().defaultTo(0);
    t.integer('output_tokens').unsigned().notNullable().defaultTo(0);
    t.string('status', 20).notNullable().defaultTo('pending'); // pending | ok | refused | truncated | error
    t.string('error_code', 40).nullable();
    t.specificType('result', 'MEDIUMTEXT').nullable();  // JSON (structured output)
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['business_id', 'created_at']);
    t.index(['user_id', 'created_at']);
    t.index(['business_id', 'appointment_id', 'kind']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('ai_requests');
  await knex.schema.dropTableIfExists('ai_clinic_settings');
};
