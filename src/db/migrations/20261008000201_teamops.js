// Team operations: internal support tickets, staff presence ("last seen"), per-user notification preferences,
// e-mail routing of in-app notifications, and e-mails a doctor sends to a patient.
//  • support_tickets / support_ticket_replies / support_ticket_reads: a member opens a ticket (category, priority),
//    managers assign and move it open → in_progress → resolved → closed; reads give per-user unread markers.
//    platform_sent_at: when the ticket was e-mailed to the platform support address (SUPPORT_EMAIL).
//  • user_presence: last page load / heartbeat per member and clinic ("online" is derived at read time).
//  • team_user_prefs: in-app sound on new notifications, and hiding one's presence from colleagues.
//  • notification_email_rules: per clinic and event key — e-mail on/off, recipient roles, members and extra addresses.
//  • doctor_emails: e-mails composed to a patient (subject + body kept for the patient's record, attachments' labels).
exports.up = async (knex) => {
  await knex.schema.createTable('support_tickets', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('number').unsigned().notNullable();                  // per clinic: #1, #2 …
    t.string('subject', 190).notNullable();
    t.string('category', 20).notNullable().defaultTo('other');     // technical | billing | equipment | hr | other
    t.string('priority', 10).notNullable().defaultTo('normal');    // low | normal | high | urgent
    t.string('status', 20).notNullable().defaultTo('open');        // open | in_progress | resolved | closed
    t.text('description').notNullable();
    t.integer('author_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('assignee_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('last_activity_at').notNullable().defaultTo(knex.fn.now());
    t.integer('last_activity_by').unsigned().nullable();
    t.integer('replies_count').unsigned().notNullable().defaultTo(0);
    t.timestamp('platform_sent_at').nullable();
    t.timestamp('resolved_at').nullable();
    t.timestamp('closed_at').nullable();
    t.timestamps(true, true);
    t.unique(['business_id', 'number']);
    t.index(['business_id', 'status']);
    t.index(['business_id', 'author_id']);
    t.index(['business_id', 'assignee_id']);
  });

  await knex.schema.createTable('support_ticket_replies', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('ticket_id').unsigned().notNullable().references('support_tickets.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('kind', 10).notNullable().defaultTo('reply');         // reply | event (status / assignment changes)
    t.text('body').nullable();
    t.json('meta').nullable();                                     // event: { status } | { assignee }
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['ticket_id', 'id']);
  });

  await knex.schema.createTable('support_ticket_reads', (t) => {
    t.integer('ticket_id').unsigned().notNullable().references('support_tickets.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.timestamp('read_at').notNullable().defaultTo(knex.fn.now());
    t.primary(['ticket_id', 'user_id']);
  });

  await knex.schema.createTable('user_presence', (t) => {
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
    t.primary(['business_id', 'user_id']);
  });

  await knex.schema.createTable('team_user_prefs', (t) => {
    t.integer('user_id').unsigned().primary().references('users.id').onDelete('CASCADE');
    t.boolean('sound_enabled').notNullable().defaultTo(true);
    t.boolean('presence_hidden').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('notification_email_rules', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('event_key', 40).notNullable();
    t.boolean('enabled').notNullable().defaultTo(false);
    t.json('roles').nullable();                                    // role keys, e.g. ["owner","clinic_manager"]
    t.json('user_ids').nullable();                                 // specific members
    t.json('emails').nullable();                                   // extra addresses
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['business_id', 'event_key']);
  });

  await knex.schema.createTable('doctor_emails', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().nullable().references('patients.id').onDelete('SET NULL');
    t.integer('appointment_id').unsigned().nullable().references('appointments.id').onDelete('SET NULL');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
    t.string('to_email', 190).notNullable();
    t.string('subject', 190).notNullable();
    t.text('body').notNullable();
    t.json('attachments').nullable();                              // [{ id, label }] of patient_documents sent
    t.string('status', 12).notNullable().defaultTo('sent');        // sent | failed
    t.string('error', 255).nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['business_id', 'patient_id', 'created_at']);
    t.index(['business_id', 'user_id', 'created_at']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('doctor_emails');
  await knex.schema.dropTableIfExists('notification_email_rules');
  await knex.schema.dropTableIfExists('team_user_prefs');
  await knex.schema.dropTableIfExists('user_presence');
  await knex.schema.dropTableIfExists('support_ticket_reads');
  await knex.schema.dropTableIfExists('support_ticket_replies');
  await knex.schema.dropTableIfExists('support_tickets');
};
