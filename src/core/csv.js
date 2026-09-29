// CSV output with a UTF-8 BOM (so Excel shows Arabic correctly) and spreadsheet formula-injection protection.
function cell(v) {
  if (typeof v === 'number') return String(v);
  let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function send(res, filename, header, rows) {
  const csv = [header.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  // ASCII fallback + RFC 5987 name: raw non-ASCII (e.g. Arabic) in a header throws ERR_INVALID_CHAR.
  res.setHeader('Content-Disposition', `attachment; filename="${String(filename).replace(/[^\x20-\x7e]+/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(`﻿${csv}`);
}

/** CSV text (with BOM) for attachments. */
function build(header, rows) {
  return `\uFEFF${[header.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n')}`;
}

module.exports = { cell, send, build };
