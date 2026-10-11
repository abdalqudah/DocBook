// The new plans (Basic 35, Advanced 50, Business 80 JOD) also on a platform whose plans had other names than the
// first defaults: when no plan is called Basic / Advanced / Business yet, the active public plans — cheapest first —
// take those names and prices (a year costs ten months). A platform that already has them is left as it is.
const PLANS = [
  { name: 'أساسي', name_en: 'Basic', price_monthly: 35, price_yearly: 350 },
  { name: 'متقدم', name_en: 'Advanced', price_monthly: 50, price_yearly: 500 },
  { name: 'الأعمال', name_en: 'Business', price_monthly: 80, price_yearly: 800 },
];

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('subscription_plans'))) return;
  if (await knex('subscription_plans').whereIn('name_en', PLANS.map((p) => p.name_en)).first('id')) return;
  const rows = await knex('subscription_plans').where({ is_active: true, is_public: true }).where('price_monthly', '>', 0)
    .orderBy([{ column: 'price_monthly' }, { column: 'sort_order' }]).limit(3).select('id');
  for (const [i, r] of rows.entries()) { // eslint-disable-line no-restricted-syntax
    await knex('subscription_plans').where({ id: r.id }).update({ ...PLANS[i], updated_at: new Date() }); // eslint-disable-line no-await-in-loop
  }
};

exports.down = async () => {};
