// Reps & warehouses: subscription plans with a free trial and monthly limits, invoices paid to the platform (manual
// transfer, confirmed by the platform admin), paid ads shown to doctors, and offers sent to chosen clinics / cities.
//   vendor_plans          price, limits: visit requests / published offers per month, clinics per offer, ad days
//   vendor_subscriptions  one per vendor: plan, status (trialing | active | past_due | expired), trial & period ends
//   vendor_invoices       VN-YYYY-######: a plan period or an ad; open → reported (vendor sent the transfer) → paid
//   vendor_ads            a sponsored card for doctors (specialties, cities), a number of days, impressions & clicks
//   vendor_offers         target: 'specialty' (default) | 'clinics'; vendor_offer_targets / vendor_offer_cities
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('vendor_plans'))) {
    await knex.schema.createTable('vendor_plans', (t) => {
      t.increments('id');
      t.string('name', 120).notNullable();
      t.string('name_en', 120).nullable();
      t.string('description', 500).nullable();
      t.string('description_en', 500).nullable();
      t.decimal('price_monthly', 12, 3).notNullable().defaultTo(0);
      t.decimal('price_yearly', 12, 3).nullable();
      t.string('currency', 3).notNullable().defaultTo('JOD');
      t.integer('max_requests_month').unsigned().nullable(); // null = unlimited
      t.integer('max_offers_month').unsigned().nullable();
      t.integer('max_offer_clinics').unsigned().nullable(); // clinics chosen for one offer
      t.integer('ad_days_month').unsigned().notNullable().defaultTo(0); // free ad days included each month
      t.boolean('is_active').notNullable().defaultTo(true);
      t.boolean('is_public').notNullable().defaultTo(true);
      t.integer('sort_order').notNullable().defaultTo(0);
      t.timestamps(true, true);
    });
  }
  if (!(await knex.schema.hasTable('vendor_subscriptions'))) {
    await knex.schema.createTable('vendor_subscriptions', (t) => {
      t.increments('id');
      t.integer('vendor_id').unsigned().notNullable().unique().references('vendors.id').onDelete('CASCADE');
      t.integer('plan_id').unsigned().nullable().references('vendor_plans.id').onDelete('SET NULL');
      t.string('status', 12).notNullable().defaultTo('trialing');
      t.string('billing_cycle', 10).notNullable().defaultTo('monthly');
      t.date('trial_ends_at').nullable();
      t.date('current_period_start').nullable();
      t.date('current_period_end').nullable();
      t.string('note', 300).nullable();
      t.timestamps(true, true);
    });
  }
  if (!(await knex.schema.hasTable('vendor_invoices'))) {
    await knex.schema.createTable('vendor_invoices', (t) => {
      t.increments('id');
      t.string('number', 24).notNullable().unique();
      t.integer('vendor_id').unsigned().notNullable().references('vendors.id').onDelete('CASCADE');
      t.string('kind', 12).notNullable(); // plan | ad
      t.integer('plan_id').unsigned().nullable();
      t.string('billing_cycle', 10).nullable();
      t.integer('ad_id').unsigned().nullable();
      t.string('description', 300).nullable();
      t.decimal('amount', 12, 3).notNullable();
      t.string('currency', 3).notNullable().defaultTo('JOD');
      t.string('status', 10).notNullable().defaultTo('open'); // open | reported | paid | void
      t.string('method', 20).nullable();
      t.string('reference', 120).nullable();
      t.timestamp('reported_at').nullable();
      t.timestamp('paid_at').nullable();
      t.integer('confirmed_by').unsigned().nullable();
      t.timestamps(true, true);
      t.index(['vendor_id', 'status']);
    });
  }
  if (!(await knex.schema.hasTable('vendor_ads'))) {
    await knex.schema.createTable('vendor_ads', (t) => {
      t.increments('id');
      t.integer('vendor_id').unsigned().notNullable().references('vendors.id').onDelete('CASCADE');
      t.integer('offer_id').unsigned().nullable().references('vendor_offers.id').onDelete('SET NULL');
      t.string('title', 120).notNullable();
      t.string('title_en', 120).nullable();
      t.string('body', 300).nullable();
      t.string('body_en', 300).nullable();
      t.specificType('image', 'MEDIUMBLOB').nullable();
      t.string('image_mime', 40).nullable();
      t.text('specialties').nullable(); // JSON [] = every specialty
      t.text('cities').nullable(); // JSON [] = everywhere
      t.date('starts_on').notNullable();
      t.integer('days').unsigned().notNullable();
      t.date('ends_on').notNullable();
      t.decimal('price', 12, 3).notNullable().defaultTo(0);
      t.string('status', 16).notNullable().defaultTo('draft'); // draft | pending_payment | approved | rejected | cancelled
      t.string('admin_note', 300).nullable();
      t.integer('impressions').unsigned().notNullable().defaultTo(0);
      t.integer('clicks').unsigned().notNullable().defaultTo(0);
      t.timestamps(true, true);
      t.index(['status', 'starts_on', 'ends_on']);
    });
  }
  if (!(await knex.schema.hasColumn('vendor_offers', 'target'))) {
    await knex.schema.alterTable('vendor_offers', (t) => { t.string('target', 10).notNullable().defaultTo('specialty'); });
  }
  if (!(await knex.schema.hasTable('vendor_offer_targets'))) {
    await knex.schema.createTable('vendor_offer_targets', (t) => {
      t.integer('offer_id').unsigned().notNullable().references('vendor_offers.id').onDelete('CASCADE');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.primary(['offer_id', 'business_id']);
    });
  }
  if (!(await knex.schema.hasTable('vendor_offer_cities'))) {
    await knex.schema.createTable('vendor_offer_cities', (t) => {
      t.integer('offer_id').unsigned().notNullable().references('vendor_offers.id').onDelete('CASCADE');
      t.string('city', 100).notNullable(); // lower-case, trimmed
      t.primary(['offer_id', 'city']);
    });
  }
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('vendor_offer_cities');
  await knex.schema.dropTableIfExists('vendor_offer_targets');
  if (await knex.schema.hasColumn('vendor_offers', 'target')) await knex.schema.alterTable('vendor_offers', (t) => t.dropColumn('target'));
  await knex.schema.dropTableIfExists('vendor_ads');
  await knex.schema.dropTableIfExists('vendor_invoices');
  await knex.schema.dropTableIfExists('vendor_subscriptions');
  await knex.schema.dropTableIfExists('vendor_plans');
};
