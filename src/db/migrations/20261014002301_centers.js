// Medical centres: several doctors' practices under one roof. Each practice stays its own clinic account (its own
// team, patients, money, website, e-mail and domain); the centre links them so they share the reception desk and
// the waiting-room screen, and — for the practices that choose to — one cash screen.
//   centers            the centre (name, its founder)
//   businesses         center_id (the practice's centre), center_share_cash (its visits on the shared cash screen)
//   center_invites     invitations for doctors to open their practice in the centre (or bring one they own)
//   queue_screens      scope 'center': a waiting-room screen showing every practice of the centre
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('centers'))) {
    await knex.schema.createTable('centers', (t) => {
      t.increments('id');
      t.string('name', 160).notNullable();
      t.string('name_en', 160).nullable();
      t.integer('owner_user_id').unsigned().nullable();
      t.integer('owner_business_id').unsigned().nullable();
      t.timestamps(true, true);
    });
  }
  if (!(await knex.schema.hasColumn('businesses', 'center_id'))) {
    await knex.schema.alterTable('businesses', (t) => {
      t.integer('center_id').unsigned().nullable().references('centers.id').onDelete('SET NULL');
      t.boolean('center_share_cash').notNullable().defaultTo(false);
      t.timestamp('center_joined_at').nullable();
    });
  }
  if (!(await knex.schema.hasTable('center_invites'))) {
    await knex.schema.createTable('center_invites', (t) => {
      t.increments('id');
      t.integer('center_id').unsigned().notNullable().references('centers.id').onDelete('CASCADE');
      t.string('email', 190).notNullable();
      t.string('token_hash', 64).notNullable().unique();
      t.integer('invited_by').unsigned().nullable();
      t.timestamp('expires_at').notNullable();
      t.timestamp('accepted_at').nullable();
      t.integer('accepted_business_id').unsigned().nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
  }
  if (await knex.schema.hasTable('queue_screens') && !(await knex.schema.hasColumn('queue_screens', 'scope'))) {
    await knex.schema.alterTable('queue_screens', (t) => { t.string('scope', 10).notNullable().defaultTo('clinic'); }); // clinic | center
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('queue_screens', 'scope')) await knex.schema.alterTable('queue_screens', (t) => t.dropColumn('scope'));
  await knex.schema.dropTableIfExists('center_invites');
  if (await knex.schema.hasColumn('businesses', 'center_id')) {
    await knex.schema.alterTable('businesses', (t) => { t.dropForeign('center_id'); t.dropColumn('center_id'); t.dropColumn('center_share_cash'); t.dropColumn('center_joined_at'); });
  }
  await knex.schema.dropTableIfExists('centers');
};
