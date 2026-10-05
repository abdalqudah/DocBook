// CSV export / import (RFC 4180). Excel opens UTF-8 CSV with the BOM correctly, Arabic included.
// Cells that start with = + - @ are prefixed with ' so a spreadsheet never runs them as formulas (CSV injection).
const cell = (v) => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(columns, rows) {
  const head = columns.map((c) => cell(c.label || c.key)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(c.value ? c.value(r) : r[c.key])).join(','));
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
}

/** Parses CSV text into an array of objects keyed by the header row. */
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim().replace(/^'(?=[=+\-@])/, '')])));
}

module.exports = { toCsv, parseCsv };
