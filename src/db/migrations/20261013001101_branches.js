// Clinic branches. A clinic's main branch is the clinic itself (its own address, phone and hours) — rows here are the
// other branches, and branch_id NULL everywhere means "main branch", so nothing changes for existing clinics.
//   • clinic_branches: name, address, phone, map, active
//   • doctors.branch_id: where the doctor works; appointments.branch_id: where the visit takes place
// Packages: how many branches a plan allows (entitlement clinic.max_branches, 1 for existing plans), its price for
// 2, 3 … branches (subscription_plans.branch_prices), and how many branches the clinic pays for (clinic_subscriptions /
// platform_invoices .branches).
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('clinic_branches'))) {
    await knex.schema.createTable('clinic_branches', (t) => {
      t.increments('id').primary();
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('name', 120).notNullable();
      t.string('name_en', 120).nullable();
      t.string('city', 120).nullable();
      t.string('address', 255).nullable();
      t.string('phone', 40).nullable();
      t.string('whatsapp', 40).nullable();
      t.string('map_url', 500).nullable();
      t.boolean('is_active').notNullable().defaultTo(true);
      t.integer('sort_order').notNullable().defaultTo(0);
      t.timestamps(true, true);
      t.index(['business_id', 'is_active']);
    });
  }
  const col = async (table, name, fn) => { if (!(await knex.schema.hasColumn(table, name))) await knex.schema.alterTable(table, fn); };
  await col('doctors', 'branch_id', (t) => { t.integer('branch_id').unsigned().nullable().references('clinic_branches.id').onDelete('SET NULL'); });
  await col('appointments', 'branch_id', (t) => { t.integer('branch_id').unsigned().nullable().references('clinic_branches.id').onDelete('SET NULL'); t.index(['business_id', 'branch_id', 'appointment_date']); });
  if (await knex.schema.hasTable('subscription_plans')) {
    await col('subscription_plans', 'branch_prices', (t) => { t.text('branch_prices').nullable(); });
    const parse = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) || {}; } catch { return {}; } };
    for (const p of await knex('subscription_plans').select('id', 'features')) {
      const f = parse(p.features);
      if (!Object.prototype.hasOwnProperty.call(f, 'clinic.max_branches')) await knex('subscription_plans').where({ id: p.id }).update({ features: JSON.stringify({ ...f, 'clinic.max_branches': 1 }) }); // eslint-disable-line no-await-in-loop
    }
  }
  if (await knex.schema.hasTable('clinic_subscriptions')) await col('clinic_subscriptions', 'branches', (t) => { t.integer('branches').unsigned().notNullable().defaultTo(1); });
  if (await knex.schema.hasTable('platform_invoices')) await col('platform_invoices', 'branches', (t) => { t.integer('branches').unsigned().notNullable().defaultTo(1); });
};

exports.down = async (knex) => {
  const drop = async (table, name, fn) => { if (await knex.schema.hasTable(table) && await knex.schema.hasColumn(table, name)) await knex.schema.alterTable(table, fn); };
  await drop('platform_invoices', 'branches', (t) => { t.dropColumn('branches'); });
  await drop('clinic_subscriptions', 'branches', (t) => { t.dropColumn('branches'); });
  await drop('subscription_plans', 'branch_prices', (t) => { t.dropColumn('branch_prices'); });
  await drop('appointments', 'branch_id', (t) => { t.dropForeign(['branch_id']); t.dropIndex(['business_id', 'branch_id', 'appointment_date']); t.dropColumn('branch_id'); });
  await drop('doctors', 'branch_id', (t) => { t.dropForeign(['branch_id']); t.dropColumn('branch_id'); });
  await knex.schema.dropTableIfExists('clinic_branches');
};
