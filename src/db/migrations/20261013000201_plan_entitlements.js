// Plan entitlements (DocBook 2.0 redesign 4.2): plans that existed before the website keys were added get explicit
// values chosen so no clinic loses what it could do (e.g. connecting its own domain stays included; the new clinic
// e-mail is not). The platform admin changes them per plan afterwards. Features are data — no plan names in code.
const VALUES = {
  'website.builder': true,
  'website.templates': '*',
  'website.custom_domain': true,
  'website.clinic_email': false,
  'website.analytics': false,
  'website.advanced_seo': false,
  'website.max_pages': null,
  'media.storage_mb': null,
  'limits.max_patients': null,
};
const parse = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) || {}; } catch { return {}; } };

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('subscription_plans'))) return;
  const plans = await knex('subscription_plans').select('id', 'features');
  for (const p of plans) {
    const f = parse(p.features);
    const add = Object.fromEntries(Object.entries(VALUES).filter(([k]) => !Object.prototype.hasOwnProperty.call(f, k)));
    if (Object.keys(add).length) await knex('subscription_plans').where({ id: p.id }).update({ features: JSON.stringify({ ...f, ...add }) }); // eslint-disable-line no-await-in-loop
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable('subscription_plans'))) return;
  const plans = await knex('subscription_plans').select('id', 'features');
  for (const p of plans) {
    const f = parse(p.features);
    Object.keys(VALUES).forEach((k) => { delete f[k]; });
    await knex('subscription_plans').where({ id: p.id }).update({ features: JSON.stringify(f) }); // eslint-disable-line no-await-in-loop
  }
};
