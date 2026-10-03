// Waiting-room screen: each doctor's room number ("عيادة 3") and the secret links of the clinic's TV screens.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('doctors', 'room'))) await knex.schema.alterTable('doctors', (t) => { t.string('room', 20).nullable(); });
  if (!(await knex.schema.hasTable('queue_screens'))) {
    await knex.schema.createTable('queue_screens', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('name', 80).notNullable();
      t.integer('branch_id').unsigned().nullable();
      t.string('token_hash', 64).notNullable().unique();
      t.text('token_enc').nullable(); // the link can be shown again to the clinic (encrypted at rest)
      t.string('name_style', 10).notNullable().defaultTo('short'); // short = "Ahmad K." (privacy) | full
      t.boolean('is_active').notNullable().defaultTo(true);
      t.integer('created_by').unsigned().nullable();
      t.timestamp('last_seen_at').nullable();
      t.timestamps(true, true);
      t.index(['business_id']);
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('queue_screens');
  if (await knex.schema.hasColumn('doctors', 'room')) await knex.schema.alterTable('doctors', (t) => { t.dropColumn('room'); });
};
