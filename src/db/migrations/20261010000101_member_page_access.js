// Per-member page access (worker: access). On top of the member's role, the clinic owner (or a manager with
// users.manage) can ALLOW a page the role doesn't give, or DENY a page the role gives. No row = follow the role.
//   page_key — a menu page key (src/routes/nav.js NAV item key) or `settings_<key>` for a Settings section
//   mode     — allow | deny
//   level    — for 'allow' on pages with a view/manage pair (e.g. expenses): view | manage (null otherwise)
exports.up = async (knex) => {
  await knex.schema.createTable('member_page_access', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('membership_id').unsigned().notNullable().references('memberships.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('page_key', 60).notNullable();
    t.string('mode', 5).notNullable(); // allow | deny
    t.string('level', 10).nullable(); // view | manage
    t.integer('granted_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['membership_id', 'page_key']);
    t.index(['business_id', 'user_id']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('member_page_access');
};
