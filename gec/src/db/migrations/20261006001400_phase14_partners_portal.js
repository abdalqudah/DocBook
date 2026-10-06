// Phase 14 — university partner portal: partner user accounts, partnership requests from the website, content
// submissions reviewed by GEC before publishing, and a per-program commission override (GEC's margin).
exports.up = async (knex) => {
  await knex.raw("ALTER TABLE users MODIFY kind ENUM('staff', 'student', 'partner') NOT NULL");
  await knex.raw("ALTER TABLE login_attempts MODIFY portal ENUM('staff', 'student', 'partner') NOT NULL");
  await knex.schema.createTable('partner_members', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().unique().references('users.id').onDelete('CASCADE');
    t.integer('university_id').unsigned().notNullable().references('universities.id').onDelete('CASCADE');
    t.enum('role', ['owner', 'editor']).notNullable().defaultTo('editor');
    t.string('job_title', 120);
    t.timestamps(true, true);
  });
  await knex.schema.createTable('partner_applications', (t) => {
    t.increments('id');
    t.string('ref', 12).notNullable().unique();
    t.string('university_name', 190).notNullable(); t.string('country_code', 2); t.string('city', 120); t.string('website', 300);
    t.string('contact_name', 160).notNullable(); t.string('job_title', 120); t.string('email', 190).notNullable(); t.string('phone', 40);
    t.text('message');
    t.enum('status', ['new', 'approved', 'rejected']).notNullable().defaultTo('new');
    t.integer('university_id').unsigned().nullable().references('universities.id').onDelete('SET NULL');
    t.integer('reviewed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('reviewed_at').nullable(); t.string('review_note', 500);
    t.timestamps(true, true);
    t.index(['status']);
  });
  await knex.schema.createTable('partner_submissions', (t) => {
    t.increments('id');
    t.integer('university_id').unsigned().notNullable().references('universities.id').onDelete('CASCADE');
    t.enum('entity', ['program', 'scholarship', 'university']).notNullable();
    t.integer('entity_id').unsigned().nullable(); // null = a new item
    t.json('data').notNullable();
    t.enum('status', ['pending', 'approved', 'rejected', 'changes_requested']).notNullable().defaultTo('pending');
    t.string('review_note', 1000);
    t.integer('submitted_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('reviewed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('reviewed_at').nullable();
    t.integer('published_id').unsigned().nullable();
    t.timestamps(true, true);
    t.index(['status', 'created_at']); t.index(['university_id', 'status']);
  });
  await knex.schema.alterTable('programs', (t) => {
    t.enum('commission_type', ['inherit', 'percent', 'fixed']).notNullable().defaultTo('inherit');
    t.decimal('commission_rate', 10, 2).nullable();
    t.integer('submitted_by_partner').unsigned().nullable();
  });
};
exports.down = async (knex) => {
  await knex.schema.alterTable('programs', (t) => { t.dropColumn('commission_type'); t.dropColumn('commission_rate'); t.dropColumn('submitted_by_partner'); });
  await knex.schema.dropTableIfExists('partner_submissions');
  await knex.schema.dropTableIfExists('partner_applications');
  await knex.schema.dropTableIfExists('partner_members');
  await knex.raw("ALTER TABLE users MODIFY kind ENUM('staff', 'student') NOT NULL");
  await knex.raw("ALTER TABLE login_attempts MODIFY portal ENUM('staff', 'student') NOT NULL");
};
