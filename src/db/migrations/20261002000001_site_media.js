// Media library for the editable landing page: images uploaded by the platform admin.
// Stored in the database (MEDIUMBLOB) so backups and multi-server set-ups need no shared disk.
exports.up = async (knex) => {
  await knex.schema.createTable('site_media', (t) => {
    t.increments('id');
    t.string('name', 150).notNullable();
    t.string('mime', 40).notNullable();
    t.integer('size').unsigned().notNullable();
    t.integer('width').unsigned().nullable();
    t.integer('height').unsigned().nullable();
    t.string('sha', 16).notNullable();
    t.specificType('data', 'MEDIUMBLOB').notNullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
};
exports.down = (knex) => knex.schema.dropTableIfExists('site_media');
