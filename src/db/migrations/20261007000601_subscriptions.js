// SaaS subscriptions for clinics (the platform sells DocBook to clinics). Off by default: the switch and the
// platform's own settings (trial length, grace period, bank / CliQ details) live in platform_settings
// under the key "subscriptions", so existing installations keep working unchanged until the super admin enables it.
//  • subscription_plans: what the platform sells (bilingual name/description, monthly and yearly price, limits where
//    NULL = unlimited, feature flags as a JSON object of feature keys).
//  • clinic_subscriptions: one row per clinic, created lazily (a fresh trial) the first time the clinic is seen while
//    subscriptions are enabled. Dates are the clinic's calendar dates.
//  • platform_invoices: invoices the platform issues to clinics (number PL-YYYY-000001), paid by a manual payment
//    confirmed by the platform admin (bank transfer / CliQ / cash). A clinic can report a payment (notice) first.
exports.up = async (knex) => {
  await knex.schema.createTable('subscription_plans', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.string('name_en', 120);
    t.string('description', 500);
    t.string('description_en', 500);
    t.decimal('price_monthly', 12, 3).notNullable().defaultTo(0);
    t.decimal('price_yearly', 12, 3).notNullable().defaultTo(0);
    t.string('currency', 3).notNullable().defaultTo('JOD');
    t.integer('max_doctors').unsigned().nullable();
    t.integer('max_staff').unsigned().nullable();
    t.integer('max_appointments_month').unsigned().nullable();
    t.json('features');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.boolean('is_public').notNullable().defaultTo(true); // hidden plans can still be assigned by the admin
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('clinic_subscriptions', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().unique().references('businesses.id').onDelete('CASCADE');
    t.integer('plan_id').unsigned().nullable().references('subscription_plans.id').onDelete('SET NULL');
    t.string('status', 20).notNullable().defaultTo('trialing'); // trialing | active | past_due | expired | cancelled | comped
    t.string('billing_cycle', 10).notNullable().defaultTo('monthly'); // monthly | yearly
    t.date('trial_ends_at');
    t.date('current_period_start');
    t.date('current_period_end');
    t.date('grace_ends_at');
    t.timestamp('cancelled_at').nullable();
    t.string('note', 500);
    t.timestamps(true, true);
    t.index(['status']);
  });

  await knex.schema.createTable('platform_invoices', (t) => {
    t.increments('id');
    t.string('number', 30).nullable().unique();
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('plan_id').unsigned().nullable().references('subscription_plans.id').onDelete('SET NULL');
    t.string('plan_name', 120);
    t.string('plan_name_en', 120);
    t.string('billing_cycle', 10).notNullable().defaultTo('monthly');
    t.date('period_start');
    t.date('period_end');
    t.decimal('amount', 12, 3).notNullable().defaultTo(0);
    t.string('currency', 3).notNullable().defaultTo('JOD');
    t.string('status', 20).notNullable().defaultTo('open'); // open | reported | paid | void
    t.string('method', 20); // bank_transfer | cliq | cash
    t.string('reference', 120);
    t.string('notice_note', 500);
    t.timestamp('reported_at').nullable();
    t.integer('reported_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('paid_at').nullable();
    t.integer('confirmed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['business_id', 'created_at']);
    t.index(['status']);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('platform_invoices');
  await knex.schema.dropTableIfExists('clinic_subscriptions');
  await knex.schema.dropTableIfExists('subscription_plans');
};
