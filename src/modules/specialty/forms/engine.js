// Specialty forms engine: a form is declared once (fields in Arabic and English, the specialties it belongs to, how its
// scores are computed) and this module reads a submitted form, checks every value, computes the results and gives the
// list of fields for the screen and the print.
//
// Field  { k, t, ar, en, unit, min, max, step, opts, side, req, trend, hint, wide }
//   t     num (decimal) | int | text | area | sel | multi | bool | date | grid
//   opts  [[value, ar, en]] for sel / multi; a score item uses numeric values (the points)
//   side  'eye' (OD/OS) | 'ear' | 'lr' (right/left): the field is asked once per side → keys `<k>_r`, `<k>_l`
//   grid  rows × cols of numbers (rows/cols: [[key, ar, en]], cell: { min, max, step, unit }) → keys `<k>__<row>__<col>`
// Form   { key, v, icon, ar, en, cite, specialties, sections: [{ ar, en, fields }], compute(d, p) → [result] }
//   result { k, ar, en, v, unit, band: { ar, en }, level: ok|mild|warn|bad }   (p = { sex, ageYears })
const { E } = require('../../../core/errors');

const SIDES = {
  eye: [['r', 'العين اليمنى (OD)', 'Right eye (OD)'], ['l', 'العين اليسرى (OS)', 'Left eye (OS)']],
  ear: [['r', 'الأذن اليمنى', 'Right ear'], ['l', 'الأذن اليسرى', 'Left ear']],
  lr: [['r', 'اليمين', 'Right'], ['l', 'اليسار', 'Left']],
};
const LEVELS = ['ok', 'mild', 'warn', 'bad'];

// ---------------------------------------------------------------- numbers typed in Arabic or English
const AR_DIGITS = /[٠-٩۰-۹]/g;
function toNumber(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().replace(AR_DIGITS, (c) => String((c.charCodeAt(0) & 0xf) % 10)).replace(/[٫,]/g, '.').replace(/\s+/g, '');
  if (!s) return null;
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return NaN;
  return Number(s);
}
const round = (n, d = 1) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Every concrete input of a form: sides and grid cells expanded. → [{ key, f, side?, row?, col? }] */
function inputsOf(form) {
  const out = [];
  for (const s of form.sections) {
    for (const f of s.fields) {
      if (f.t === 'grid') {
        for (const [r] of f.rows) for (const [c] of f.cols) out.push({ key: `${f.k}__${r}__${c}`, f: { ...f, ...f.cell, t: f.cell.t || 'num' }, row: r, col: c, grid: f.k });
      } else if (f.side) {
        for (const [sd] of SIDES[f.side]) out.push({ key: `${f.k}_${sd}`, f, side: sd });
      } else out.push({ key: f.k, f });
    }
  }
  return out;
}

const optValues = (f) => f.opts.map((o) => String(o[0]));

/** One value from the submitted body (`f_<key>`); returns [value, error]. Empty → [null]. */
function readValue(f, raw) {
  if (f.t === 'multi') {
    const list = [].concat(raw === undefined || raw === null || raw === '' ? [] : raw).map(String);
    const ok = optValues(f);
    if (list.some((v) => !ok.includes(v))) return [null, 'Choose a valid value.'];
    return [list.length ? [...new Set(list)] : null];
  }
  if (f.t === 'bool') return [raw === '1' || raw === 'on' || raw === true ? true : null];
  const v = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s) return [null];
  switch (f.t) {
    case 'num': case 'int': {
      const n = toNumber(s);
      if (!Number.isFinite(n)) return [null, 'Enter a number.'];
      if (f.t === 'int' && !Number.isInteger(n)) return [null, 'Enter a whole number.'];
      if (f.min !== undefined && n < f.min) return [null, 'Too small.'];
      if (f.max !== undefined && n > f.max) return [null, 'Too large.'];
      return [n];
    }
    case 'sel': {
      if (!optValues(f).includes(s)) return [null, 'Choose a valid value.'];
      const o = f.opts.find((x) => String(x[0]) === s);
      return [typeof o[0] === 'number' ? o[0] : s];
    }
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return [null, 'Enter a valid date.'];
      return [s];
    case 'area': return s.length > 4000 ? [null, 'Too long.'] : [s];
    default: return s.length > 500 ? [null, 'Too long.'] : [s];
  }
}

/**
 * Reads and checks a submitted form. Returns { data, results, level, headline } or throws a validation error with the
 * messages keyed `f_<key>` (as the inputs are named). A form with nothing entered is refused.
 */
function read(form, body, patient = {}) {
  const data = {};
  const errors = {};
  for (const inp of inputsOf(form)) {
    const [v, err] = readValue(inp.f, body[`f_${inp.key}`]);
    if (err) errors[`f_${inp.key}`] = err;
    else if (v !== null) data[inp.key] = v;
    else if (inp.f.req) errors[`f_${inp.key}`] = 'Required.';
  }
  if (Object.keys(errors).length) throw E.validation(errors);
  if (!Object.keys(data).length) throw E.validation({ form: 'Enter at least one value.' });
  if (form.check) {
    const more = form.check(data) || {};
    if (Object.keys(more).length) throw E.validation(Object.fromEntries(Object.entries(more).map(([k, m]) => [`f_${k}`, m])));
  }
  const { results, level, headline } = evaluate(form, data, patient);
  return { data, results, level, headline };
}

/** Computes the results of stored data (also used for the live preview). */
function evaluate(form, data, patient = {}) {
  let results = [];
  try { results = form.compute ? (form.compute(data, patient) || []).filter((r) => r && r.v !== null && r.v !== undefined && r.v !== '') : []; } catch { results = []; }
  const level = results.reduce((acc, r) => (r.level && LEVELS.indexOf(r.level) > LEVELS.indexOf(acc || 'ok') ? r.level : acc), results.some((r) => r.level) ? 'ok' : null);
  const main = results[0];
  const headline = main ? `${main.v}${main.unit ? ` ${main.unit}` : ''}`.slice(0, 255) : null;
  return { results, level, headline };
}

// ---------------------------------------------------------------- helpers for form definitions
/** Band of a value: bands = [[upTo (exclusive, null = no limit), level, ar, en], …] in rising order. */
function band(value, bands) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  for (const [upTo, level, ar, en] of bands) if (upTo === null || value < upTo) return { level, band: { ar, en } };
  return null;
}
/** A result row with its band. */
function result(k, ar, en, v, { unit = null, bands = null, d = 1, level = null, text = null } = {}) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return null;
  const val = typeof v === 'number' ? round(v, d) : v;
  const b = bands ? band(typeof v === 'number' ? v : NaN, bands) : null;
  return { k, ar, en, v: val, unit, band: text || (b && b.band) || null, level: level || (b && b.level) || null };
}
/** Sum of the given keys when all are answered (else null), or of those answered when `partial`. */
function sum(d, keys, { partial = false } = {}) {
  const vals = keys.map((k) => d[k]);
  if (!partial && vals.some((v) => typeof v !== 'number')) return null;
  const nums = vals.filter((v) => typeof v === 'number');
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const opts = (...list) => list.map((o) => (Array.isArray(o) ? o : [o, String(o), String(o)]));
/** Score options 0..n with labels. */
const points = (labels) => labels.map(([ar, en], i) => [i, `${i} — ${ar}`, `${i} — ${en}`]);
const yesNo = [['yes', 'نعم', 'Yes'], ['no', 'لا', 'No']];

/** Field labels for display: [{ label: {ar,en}, value }] of the entered values (sides and grids flattened). */
function describe(form, data) {
  const out = [];
  for (const s of form.sections) {
    const rows = [];
    for (const f of s.fields) {
      if (f.t === 'grid') {
        const cells = [];
        for (const [r, rar, ren] of f.rows) {
          const row = f.cols.map(([c]) => data[`${f.k}__${r}__${c}`]);
          if (row.some((v) => v !== undefined)) cells.push({ label: { ar: rar, en: ren }, values: row.map((v) => (v === undefined ? null : v)) });
        }
        if (cells.length) rows.push({ grid: true, f, label: { ar: f.ar, en: f.en }, cols: f.cols.map(([, ar, en]) => ({ ar, en })), rows: cells, unit: f.cell.unit || null });
      } else if (f.side) {
        const vals = SIDES[f.side].map(([sd, ar, en]) => ({ side: { ar, en }, v: data[`${f.k}_${sd}`] }));
        if (vals.some((x) => x.v !== undefined)) rows.push({ f, label: { ar: f.ar, en: f.en }, sides: vals.map((x) => ({ side: x.side, value: x.v === undefined ? null : show(f, x.v) })) });
      } else if (data[f.k] !== undefined) rows.push({ f, label: { ar: f.ar, en: f.en }, value: show(f, data[f.k]) });
    }
    if (rows.length) out.push({ title: { ar: s.ar, en: s.en }, rows });
  }
  return out;
}
/** A stored value as { ar, en } text. */
function show(f, v) {
  if (v === null || v === undefined) return null;
  if (f.t === 'bool') return v ? { ar: 'نعم', en: 'Yes' } : null;
  if (f.t === 'sel' || f.t === 'multi') {
    const list = [].concat(v).map((x) => f.opts.find((o) => String(o[0]) === String(x))).filter(Boolean);
    return { ar: list.map((o) => o[1]).join('، '), en: list.map((o) => o[2]).join(', ') };
  }
  const t = `${v}${f.unit ? ` ${f.unit}` : ''}`;
  return { ar: t, en: t };
}

module.exports = { SIDES, LEVELS, toNumber, round, inputsOf, readValue, read, evaluate, band, result, sum, num, opts, points, yesNo, describe, show };
