// Staff home: "What needs attention today?" first, then a few KPIs. Each module feeds the queue (registry.attention).
const registry = require('./registry');

async function page(req, res) {
  const lists = await Promise.all(registry.attention.map((fn) => fn(req).catch((e) => { console.error('[dashboard]', e.message); return []; }))); // eslint-disable-line no-console
  const order = { bad: 0, warn: 1, brand: 2, info: 3, ok: 4 };
  const queue = lists.flat().sort((a, b) => (order[a.tone] ?? 9) - (order[b.tone] ?? 9) || String(a.due || '').localeCompare(String(b.due || ''))).slice(0, 40);
  const kpis = [];
  for (const fn of (page.kpis || [])) kpis.push(...(await fn(req).catch(() => []))); // eslint-disable-line no-await-in-loop
  res.page('pages/staff/dashboard', { layout: 'staff', title: req.t('nav.dashboard'), queue, kpis });
}
page.kpis = []; // modules push async (req) => [{ key, label, value, href, note, tone }]

module.exports = { page };
