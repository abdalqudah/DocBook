// Phase 3 — catalogue: destinations, universities, programs, scholarships; shortlist, comparisons, cost estimates.
exports.up = async (knex) => {
  await knex.schema.createTable('currency_rates', (t) => {
    t.string('code', 3).primary();
    t.decimal('per_usd', 18, 6).notNullable(); // units of this currency for 1 USD
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });
  await knex('currency_rates').insert([
    { code: 'USD', per_usd: 1 }, { code: 'GBP', per_usd: 0.79 }, { code: 'EUR', per_usd: 0.92 }, { code: 'CAD', per_usd: 1.36 }, { code: 'AUD', per_usd: 1.52 },
    { code: 'NZD', per_usd: 1.66 }, { code: 'JOD', per_usd: 0.709 }, { code: 'SAR', per_usd: 3.75 }, { code: 'AED', per_usd: 3.6725 }, { code: 'KWD', per_usd: 0.307 },
    { code: 'QAR', per_usd: 3.64 }, { code: 'MYR', per_usd: 4.7 }, { code: 'TRY', per_usd: 32 },
  ]);

  const seo = (t) => { t.string('seo_title_en', 160); t.string('seo_title_ar', 160); t.string('seo_description_en', 300); t.string('seo_description_ar', 300); };

  await knex.schema.createTable('destinations', (t) => {
    t.increments('id');
    t.string('slug', 140).notNullable().unique();
    t.string('country_code', 2).notNullable();
    t.string('name_en', 120).notNullable(); t.string('name_ar', 120);
    t.string('tagline_en', 255); t.string('tagline_ar', 255);
    t.text('intro_en'); t.text('intro_ar');
    t.json('why_en'); t.json('why_ar');
    t.string('hero_image', 500);
    t.string('currency', 3).notNullable().defaultTo('USD');
    t.integer('tuition_min').nullable(); t.integer('tuition_max').nullable(); // per year, destination currency
    t.integer('living_month_min').nullable(); t.integer('living_month_max').nullable();
    t.string('post_study_work_en', 255); t.string('post_study_work_ar', 255);
    t.string('visa_type', 120);
    t.string('intakes_en', 255); t.string('intakes_ar', 255);
    t.json('regions'); // optional sub-regions (e.g. US states): [{ name_en, name_ar, overview_en, overview_ar, tuition, living }]
    t.json('cost_profile'); // calculator defaults per year in destination currency: accommodation, food, transport, insurance, visa, flights, other
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('is_featured').notNullable().defaultTo(true);
    t.boolean('is_active').notNullable().defaultTo(true);
    seo(t);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('universities', (t) => {
    t.increments('id');
    t.string('slug', 140).notNullable().unique();
    t.string('name_en', 190).notNullable(); t.string('name_ar', 190);
    t.integer('destination_id').unsigned().nullable().references('destinations.id').onDelete('SET NULL');
    t.string('country_code', 2);
    t.string('city_en', 120); t.string('city_ar', 120); t.string('state', 120);
    t.string('website', 255);
    t.string('logo', 500); t.string('cover_image', 500);
    t.text('description_en'); t.text('description_ar');
    t.integer('ranking_world').unsigned().nullable(); t.integer('ranking_national').unsigned().nullable(); t.string('ranking_source', 120);
    t.enum('institution_type', ['public', 'private', 'community_college', 'pathway', 'language_school']).nullable();
    t.text('campus_en'); t.text('campus_ar'); t.text('accommodation_en'); t.text('accommodation_ar');
    t.string('currency', 3).notNullable().defaultTo('USD');
    t.integer('tuition_min').nullable(); t.integer('tuition_max').nullable(); t.integer('application_fee').nullable();
    t.text('admission_en'); t.text('admission_ar');
    t.decimal('min_ielts', 3, 1).nullable(); t.integer('min_toefl').nullable(); t.integer('min_pte').nullable(); t.integer('min_duolingo').nullable();
    t.json('intakes'); // month numbers
    t.string('deadlines_en', 255); t.string('deadlines_ar', 255);
    t.json('documents_required');
    t.string('contact_email', 190); t.string('contact_phone', 60);
    t.enum('partner_status', ['none', 'prospect', 'active', 'paused', 'ended']).notNullable().defaultTo('none');
    t.text('commission_note'); // internal
    t.text('internal_notes'); // internal
    t.boolean('is_featured').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    seo(t);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['destination_id', 'is_active']);
  });

  await knex.schema.createTable('programs', (t) => {
    t.increments('id');
    t.string('slug', 140).notNullable().unique();
    t.integer('university_id').unsigned().notNullable().references('universities.id').onDelete('CASCADE');
    t.string('name_en', 190).notNullable(); t.string('name_ar', 190);
    t.string('degree_level', 20).notNullable(); // reference.DEGREES
    t.string('field', 40).notNullable(); // reference.FIELDS
    t.string('faculty', 160);
    t.integer('duration_months').unsigned().nullable();
    t.string('currency', 3).notNullable().defaultTo('USD');
    t.integer('tuition_fee').nullable(); // per year
    t.integer('tuition_usd').nullable(); // normalised for search and matching
    t.integer('application_fee').nullable();
    t.json('intakes'); // month numbers 1-12
    t.date('next_deadline').nullable(); t.string('deadline_note', 190);
    t.decimal('min_gpa_pct', 5, 2).nullable(); // minimum grade as a percentage (3.0/4 → 75)
    t.text('academic_en'); t.text('academic_ar');
    t.decimal('min_ielts', 3, 1).nullable(); t.decimal('min_ielts_band', 3, 1).nullable();
    t.integer('min_toefl').nullable(); t.integer('min_pte').nullable(); t.integer('min_duolingo').nullable();
    t.json('documents_required');
    t.boolean('scholarships_available').notNullable().defaultTo(false);
    t.enum('internship', ['none', 'optional', 'included', 'coop']).notNullable().defaultTo('none');
    t.enum('study_mode', ['on_campus', 'online', 'blended']).notNullable().defaultTo('on_campus');
    t.boolean('work_after_study').notNullable().defaultTo(false); t.string('work_after_study_note', 255);
    t.string('program_url', 500);
    t.text('description_en'); t.text('description_ar');
    t.text('internal_notes');
    t.boolean('is_active').notNullable().defaultTo(true);
    seo(t);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.index(['degree_level', 'field', 'is_active']);
    t.index(['tuition_usd']);
  });
  await knex.raw('ALTER TABLE programs ADD FULLTEXT INDEX programs_search (name_en, name_ar, faculty)');
  await knex.raw('ALTER TABLE universities ADD FULLTEXT INDEX universities_search (name_en, name_ar, city_en)');

  await knex.schema.createTable('scholarships', (t) => {
    t.increments('id');
    t.string('slug', 140).notNullable().unique();
    t.string('name_en', 190).notNullable(); t.string('name_ar', 190);
    t.integer('university_id').unsigned().nullable().references('universities.id').onDelete('SET NULL');
    t.integer('destination_id').unsigned().nullable().references('destinations.id').onDelete('SET NULL');
    t.integer('program_id').unsigned().nullable().references('programs.id').onDelete('SET NULL');
    t.string('provider_en', 190); t.string('provider_ar', 190);
    t.enum('amount_type', ['fixed', 'percentage', 'full', 'varies']).notNullable().defaultTo('fixed');
    t.integer('amount_min').nullable(); t.integer('amount_max').nullable(); t.string('currency', 3).notNullable().defaultTo('USD');
    t.string('coverage_en', 255); t.string('coverage_ar', 255);
    t.text('description_en'); t.text('description_ar');
    t.json('eligibility_en'); t.json('eligibility_ar');
    t.json('nationalities'); // ISO codes; empty = any
    t.json('degree_levels'); t.json('fields');
    t.decimal('min_gpa_pct', 5, 2).nullable(); t.decimal('min_ielts', 3, 1).nullable();
    t.date('deadline').nullable(); t.string('deadline_note', 190);
    t.string('source_url', 500);
    t.boolean('is_active').notNullable().defaultTo(true);
    seo(t);
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('shortlist_items', (t) => {
    t.increments('id');
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('CASCADE');
    t.string('visitor_key', 64).nullable(); // anonymous visitors (session) until they sign in
    t.enum('item_type', ['program', 'university', 'scholarship']).notNullable();
    t.integer('item_id').unsigned().notNullable();
    t.string('note', 255);
    t.integer('added_by').unsigned().nullable().references('users.id').onDelete('SET NULL'); // a counsellor adding for the student
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['student_id', 'item_type', 'item_id']);
    t.unique(['visitor_key', 'item_type', 'item_id']);
  });

  await knex.schema.createTable('comparisons', (t) => {
    t.increments('id');
    t.string('token', 32).notNullable().unique();
    t.string('title', 160);
    t.json('program_ids').notNullable();
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('CASCADE');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('cost_estimates', (t) => {
    t.increments('id');
    t.string('token', 32).notNullable().unique();
    t.integer('student_id').unsigned().nullable().references('students.id').onDelete('CASCADE');
    t.integer('lead_id').unsigned().nullable().references('leads.id').onDelete('CASCADE');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('title', 190);
    t.string('currency', 3).notNullable();
    t.json('items').notNullable(); // [{ destination, label, tuition, accommodation, ... , total }]
    t.text('note');
    t.timestamp('sent_at').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = async (knex) => {
  for (const t of ['cost_estimates', 'comparisons', 'shortlist_items', 'scholarships', 'programs', 'universities', 'destinations', 'currency_rates']) await knex.schema.dropTableIfExists(t); // eslint-disable-line no-await-in-loop
};
