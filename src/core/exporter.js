// CSV / Excel export for any table. Requires the data.export permission (checked here).
const csv = require('./csv');
const xlsx = require('./xlsx');
const { E } = require('./errors');

function send(req, res, { name, header, rows }) {
  if (!req.ctx.permissions.has('data.export')) throw E.forbidden('data.export');
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${String(name).replace(/[^\p{L}\p{N}_-]+/gu, '-')}-${stamp}`;
  if (req.query.format === 'xlsx') return xlsx.send(res, `${base}.xlsx`, [{ name, header, rows }], { rtl: req.locale === 'ar' });
  return csv.send(res, `${base}.csv`, header, rows);
}

module.exports = { send };
