// Data that some blocks show (programs from the catalogue), loaded when a page is rendered.
const finder = require('../catalog/finder.service');

async function withData(list) {
  return Promise.all((list || []).filter((b) => !b.hidden).map(async (b) => {
    if (b.type !== 'programs') return b;
    const q = finder.baseQuery().select(finder.COLUMNS).limit(b.limit || 6).orderByRaw('p.next_deadline IS NULL, p.next_deadline');
    if (b.country) q.where('u.country_code', b.country);
    if (b.degree) q.where('p.degree_level', b.degree);
    if (b.field) q.where('p.field', b.field);
    const rows = await q;
    return { ...b, programs: rows.map(finder.shape) };
  }));
}

module.exports = { withData };
