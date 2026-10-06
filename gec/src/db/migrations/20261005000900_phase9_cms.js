// Phase 9 — website CMS: pages, articles (resource centre), FAQs, testimonials, services and navigation, all in
// English and Arabic with SEO fields; plus privacy requests (data export / deletion) handled by staff.
exports.up = async (knex) => {
  const seo = (t) => { t.string('seo_title_en', 160); t.string('seo_title_ar', 160); t.string('seo_description_en', 300); t.string('seo_description_ar', 300); t.string('og_image', 500); };
  const bi = (t, name, len = 255) => { t.string(`${name}_en`, len); t.string(`${name}_ar`, len); };
  await knex.schema.createTable('pages', (t) => {
    t.increments('id');
    t.string('slug', 140).notNullable().unique();
    bi(t, 'title', 190); bi(t, 'lead', 400); t.text('body_en'); t.text('body_ar');
    t.string('hero_image', 500);
    t.boolean('show_cta').notNullable().defaultTo(true);
    t.boolean('is_published').notNullable().defaultTo(true);
    seo(t);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await knex.schema.createTable('articles', (t) => {
    t.increments('id');
    t.string('slug', 160).notNullable().unique();
    bi(t, 'title', 190); bi(t, 'excerpt', 400); t.text('body_en'); t.text('body_ar');
    t.enum('category', ['study_abroad', 'visa', 'scholarships', 'universities', 'ielts', 'student_life', 'application_tips']).notNullable().defaultTo('study_abroad');
    t.integer('author_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.string('author_name', 160);
    t.string('image', 500);
    t.integer('read_minutes').unsigned();
    t.json('tags');
    t.timestamp('published_at').nullable();
    t.boolean('is_published').notNullable().defaultTo(false);
    seo(t);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['is_published', 'published_at']); t.index(['category']);
  });
  await knex.schema.createTable('faqs', (t) => {
    t.increments('id');
    bi(t, 'category', 120); t.string('question_en', 400); t.string('question_ar', 400); t.text('answer_en'); t.text('answer_ar');
    t.string('topic', 30); // e.g. visa, destination slug — where else it is shown
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('is_published').notNullable().defaultTo(true);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });
  await knex.schema.createTable('testimonials', (t) => {
    t.increments('id');
    bi(t, 'name', 120); bi(t, 'country', 80); bi(t, 'university', 160); bi(t, 'program', 160);
    t.text('quote_en'); t.text('quote_ar');
    t.integer('year'); t.string('destination', 60); t.string('avatar', 500);
    t.boolean('consent_on_file').notNullable().defaultTo(false); // the person agreed to publication
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('is_published').notNullable().defaultTo(false);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });
  await knex.schema.createTable('services', (t) => {
    t.increments('id');
    t.string('slug', 140).notNullable().unique();
    bi(t, 'title', 160); t.text('description_en'); t.text('description_ar');
    t.string('icon', 40); t.string('timeline_en', 120); t.string('timeline_ar', 120);
    t.json('deliverables_en'); t.json('deliverables_ar'); bi(t, 'highlight', 255);
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('is_published').notNullable().defaultTo(true);
    t.boolean('is_demo').notNullable().defaultTo(false);
    seo(t);
    t.timestamps(true, true);
  });
  await knex.schema.createTable('nav_items', (t) => {
    t.increments('id');
    t.enum('location', ['header', 'footer']).notNullable().defaultTo('header');
    bi(t, 'label', 80); t.string('href', 300).notNullable();
    t.string('group', 30); // footer column
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });
  await knex.schema.createTable('privacy_requests', (t) => {
    t.increments('id');
    t.string('ref', 12).notNullable().unique();
    t.enum('type', ['export', 'delete', 'correct', 'other']).notNullable();
    t.enum('status', ['open', 'verifying', 'done', 'rejected']).notNullable().defaultTo('open');
    t.string('email', 190); t.string('name', 160);
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('SET NULL');
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('SET NULL');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.text('details'); t.string('resolution', 500);
    t.boolean('identity_verified').notNullable().defaultTo(false); // signed-in student requests are verified
    t.integer('handled_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('handled_at').nullable();
    t.timestamps(true, true);
    t.index(['status']);
  });
  await knex.schema.alterTable('students', (t) => { t.timestamp('anonymized_at').nullable(); });
  await knex.schema.alterTable('leads', (t) => { t.timestamp('anonymized_at').nullable(); });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('leads', (t) => { t.dropColumn('anonymized_at'); });
  await knex.schema.alterTable('students', (t) => { t.dropColumn('anonymized_at'); });
  for (const t of ['privacy_requests', 'nav_items', 'services', 'testimonials', 'faqs', 'articles', 'pages']) await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
};
