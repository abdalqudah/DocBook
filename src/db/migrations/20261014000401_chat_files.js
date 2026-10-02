// Staff chat attachments: images and documents sent in a conversation (stored in the database like the clinic's
// other files, read back only by people who can read that conversation).
exports.up = async (knex) => {
  if (await knex.schema.hasTable('staff_chat_files')) return;
  await knex.schema.createTable('staff_chat_files', (t) => {
    t.increments('id');
    t.integer('message_id').unsigned().notNullable().references('staff_chat_messages.id').onDelete('CASCADE');
    t.integer('chat_id').unsigned().notNullable().references('staff_chats.id').onDelete('CASCADE');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('name', 160).notNullable();
    t.string('mime', 100).notNullable();
    t.integer('size').unsigned().notNullable();
    t.specificType('data', 'MEDIUMBLOB').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['message_id']);
  });
};
exports.down = (knex) => knex.schema.dropTableIfExists('staff_chat_files');
