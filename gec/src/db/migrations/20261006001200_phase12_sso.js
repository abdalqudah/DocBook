// Phase 12 — sign in with Google / Microsoft: one row per external account linked to a user.
exports.up = async (knex) => {
  await knex.schema.createTable('user_identities', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.enum('provider', ['google', 'microsoft']).notNullable();
    t.string('subject', 191).notNullable(); // the provider's stable account id (sub; Microsoft: tid:oid)
    t.string('email', 190);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_used_at').nullable();
    t.unique(['provider', 'subject']);
    t.unique(['user_id', 'provider']);
  });
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('user_identities'); };
