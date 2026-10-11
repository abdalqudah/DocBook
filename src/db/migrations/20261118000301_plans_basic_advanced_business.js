// The three public plans get their new names and prices — Basic 35, Advanced 50, Business 80 (JOD a month; a year
// costs ten months) — and the free trial becomes 14 days. The plans are found by their earlier names (Arabic or
// English), so a plan the admin renamed to something else is left as it is. The quotation services made from them
// (the starter sales kit) follow.
const PLANS = [
  { from: ['البداية', 'Starter'], name: 'أساسي', name_en: 'Basic', price_monthly: 35, price_yearly: 350, service: ['الباقة الأساسية', 'Basic plan'] },
  { from: ['النمو', 'Growth'], name: 'متقدم', name_en: 'Advanced', price_monthly: 50, price_yearly: 500, service: ['الباقة المتقدمة', 'Advanced plan'] },
  { from: ['الشبكة', 'Network'], name: 'الأعمال', name_en: 'Business', price_monthly: 80, price_yearly: 800, service: ['باقة الأعمال', 'Business plan'] },
];

exports.up = async (knex) => {
  if (await knex.schema.hasTable('subscription_plans')) {
    for (const p of PLANS) { // eslint-disable-line no-restricted-syntax
      await knex('subscription_plans').where((w) => w.whereIn('name', p.from).orWhereIn('name_en', p.from)) // eslint-disable-line no-await-in-loop
        .update({ name: p.name, name_en: p.name_en, price_monthly: p.price_monthly, price_yearly: p.price_yearly, updated_at: new Date() });
      if (await knex.schema.hasTable('sales_services')) { // eslint-disable-line no-await-in-loop
        for (const [ar, en, price] of [['اشتراك شهري', 'monthly', p.price_monthly], ['اشتراك سنوي', 'yearly', p.price_yearly]]) { // eslint-disable-line no-restricted-syntax
          await knex('sales_services').where({ name_ar: `باقة ${p.from[0]} — ${ar}` }) // eslint-disable-line no-await-in-loop
            .update({ name_ar: `${p.service[0]} — ${ar}`, name_en: `${p.service[1]} — ${en}`, price, updated_at: new Date() });
        }
      }
    }
  }
  if (await knex.schema.hasTable('platform_settings')) {
    const row = await knex('platform_settings').where({ key: 'subscriptions' }).first('value');
    if (row) {
      let v = {};
      try { v = JSON.parse(row.value || '{}') || {}; } catch { v = {}; }
      v.trialDays = 14;
      await knex('platform_settings').where({ key: 'subscriptions' }).update({ value: JSON.stringify(v), updated_at: new Date() });
    }
  }
};

exports.down = async () => {};
