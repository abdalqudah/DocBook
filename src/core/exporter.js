// CSV / Excel export for any table. Requires the data.export permission (checked here). Every export is written to the
// clinic's audit log (which list, how many rows, the format), never its contents.
const csv = require('./csv');
const xlsx = require('./xlsx');
const { E } = require('./errors');

function send(req, res, { name, header, rows }) {
  if (!req.ctx.permissions.has('data.export')) throw E.forbidden('data.export');
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${String(name).replace(/[^\p{L}\p{N}_-]+/gu, '-')}-${stamp}`;
  require('./audit').record(req.ctx, 'data.list_exported', { entityType: 'export', entityId: null, newValues: { list: String(name).slice(0, 190), path: String(req.originalUrl || req.path).split('?')[0].slice(0, 190), rows: rows.length, format: req.query.format === 'xlsx' ? 'xlsx' : 'csv' } }).catch(() => {}); // eslint-disable-line global-require
  if (req.query.format === 'xlsx') return xlsx.send(res, `${base}.xlsx`, [{ name, header, rows }], { rtl: req.locale === 'ar' });
  return csv.send(res, `${base}.csv`, header, rows);
}

module.exports = { send };
