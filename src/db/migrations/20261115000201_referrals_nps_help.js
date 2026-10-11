// Referrals (a clinic's invitation link; a free month when the clinic it brought pays), clinics' feedback score
// (NPS: 0–10 and a comment), and the platform's help articles.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('businesses', 'referral_code'))) {
    await knex.schema.alterTable('businesses', (t) => { t.string('referral_code', 16).nullable().unique(); t.integer('referred_by').unsigned().nullable(); });
  }
  if (!(await knex.schema.hasTable('referral_rewards'))) {
    await knex.schema.createTable('referral_rewards', (t) => {
      t.increments('id');
      t.integer('referrer_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('referred_id').unsigned().notNullable().unique().references('businesses.id').onDelete('CASCADE');
      t.integer('invoice_id').unsigned().nullable();
      t.string('applied', 20).notNullable(); // period | trial | credit (the referrer had no running subscription)
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
  }
  if (!(await knex.schema.hasTable('nps_responses'))) {
    await knex.schema.createTable('nps_responses', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('user_id').unsigned().nullable();
      t.integer('score').nullable(); // null = "not now"
      t.string('comment', 1000).nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['business_id', 'created_at']);
    });
  }
  if (!(await knex.schema.hasTable('help_articles'))) {
    await knex.schema.createTable('help_articles', (t) => {
      t.increments('id');
      t.string('slug', 80).notNullable().unique();
      t.string('category', 40).notNullable().defaultTo('start');
      t.string('title_ar', 200).notNullable();
      t.string('title_en', 200).nullable();
      t.text('body_ar').notNullable();
      t.text('body_en').nullable();
      t.integer('sort').notNullable().defaultTo(0);
      t.boolean('published').notNullable().defaultTo(true);
      t.integer('views').unsigned().notNullable().defaultTo(0);
      t.timestamps(true, true);
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('help_articles');
  await knex.schema.dropTableIfExists('nps_responses');
  await knex.schema.dropTableIfExists('referral_rewards');
  if (await knex.schema.hasColumn('businesses', 'referral_code')) await knex.schema.alterTable('businesses', (t) => { t.dropColumn('referral_code'); t.dropColumn('referred_by'); });
};
