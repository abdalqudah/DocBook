// Website navigation from Website → Navigation. When no items are defined, the built-in links (each module adds its
// own) are used, so the site always has a working menu. Cached in memory; cleared whenever an item changes.
const knex = require('../../db/knex');

let cache = null;
const clear = () => { cache = null; };

async function load() {
  if (cache) return cache;
  const rows = (await knex.schema.hasTable('nav_items')) ? await knex('nav_items').where({ is_active: true }).orderBy('position').orderBy('id') : [];
  const label = (r) => ({ en: r.label_en, ar: r.label_ar || r.label_en });
  const header = rows.filter((r) => r.location === 'header').map((r) => ({ key: `cms${r.id}`, href: r.href, label: label(r) }));
  const groups = {};
  rows.filter((r) => r.location === 'footer').forEach((r) => { const g = r.group || 'company'; (groups[g] = groups[g] || []).push({ href: r.href, label: label(r) }); });
  cache = { header: header.length ? header : null, footer: Object.keys(groups).length ? Object.entries(groups).map(([key, links]) => ({ key, links })) : null };
  return cache;
}

module.exports = { load, clear };
