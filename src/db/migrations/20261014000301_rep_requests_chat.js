// Medical reps and staff chat:
//   • businesses.rep_requests_off — a clinic listed in the public directory receives rep visit REQUESTS (a suggested
//     date and time within a doctor's working hours, the clinic confirms) unless it turns them off; clinics that set
//     rep windows keep exact bookable times as before.
//   • rep_visits.flexible — the visit was requested at a suggested time (not a reserved rep window).
//   • staff_chats / staff_chat_members / staff_chat_messages — internal chat between the members of one clinic
//     (one-to-one conversations and the clinic-wide room); last_read_id per member drives the unread badge.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('businesses', 'rep_requests_off'))) await knex.schema.alterTable('businesses', (t) => { t.boolean('rep_requests_off').notNullable().defaultTo(false); });
  if (!(await knex.schema.hasColumn('rep_visits', 'flexible'))) await knex.schema.alterTable('rep_visits', (t) => { t.boolean('flexible').notNullable().defaultTo(false); });
  if (!(await knex.schema.hasTable('staff_chats'))) {
    await knex.schema.createTable('staff_chats', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('kind', 10).notNullable(); // room | direct
      t.string('pair_key', 40).nullable(); // direct: "<minUserId>:<maxUserId>" (one conversation per pair)
      t.integer('last_message_id').unsigned().nullable();
      t.timestamp('last_message_at').nullable();
      t.timestamps(true, true);
      t.unique(['business_id', 'kind', 'pair_key']);
    });
  }
  if (!(await knex.schema.hasTable('staff_chat_members'))) {
    await knex.schema.createTable('staff_chat_members', (t) => {
      t.integer('chat_id').unsigned().notNullable().references('staff_chats.id').onDelete('CASCADE');
      t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
      t.integer('last_read_id').unsigned().notNullable().defaultTo(0);
      t.primary(['chat_id', 'user_id']);
      t.index(['user_id']);
    });
  }
  if (!(await knex.schema.hasTable('staff_chat_messages'))) {
    await knex.schema.createTable('staff_chat_messages', (t) => {
      t.increments('id');
      t.integer('chat_id').unsigned().notNullable().references('staff_chats.id').onDelete('CASCADE');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
      t.text('body').notNullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['chat_id', 'id']);
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('staff_chat_messages');
  await knex.schema.dropTableIfExists('staff_chat_members');
  await knex.schema.dropTableIfExists('staff_chats');
  if (await knex.schema.hasColumn('rep_visits', 'flexible')) await knex.schema.alterTable('rep_visits', (t) => { t.dropColumn('flexible'); });
  if (await knex.schema.hasColumn('businesses', 'rep_requests_off')) await knex.schema.alterTable('businesses', (t) => { t.dropColumn('rep_requests_off'); });
};
