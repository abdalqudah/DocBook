// Small helpers shared by the "records" screens (patients, billing, dashboard, my day, reports, search).
// Timestamps (invoices.created_at, arrived_at…) are stored in UTC; clinic days are converted to UTC bounds here
// so "today" and date filters follow the clinic's time zone, not the server's.
const knex = require('../../db/knex');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (d) => ISO.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function monthBounds(month) {
  const from = `${month}-01`;
  return { from, to: addDays(`${addMonths(month, 1)}-01`, -1) };
}

/** Offset (minutes) of a time zone at an instant. */
function tzOffset(tz, at) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - at.getTime()) / 60000);
}
/** The UTC instant of local midnight at the start of `date` in the clinic's time zone. */
function startOfDay(date, tz) {
  const guess = new Date(`${date}T00:00:00Z`);
  const off = tzOffset(tz, guess);
  const first = new Date(guess.getTime() - off * 60000);
  const off2 = tzOffset(tz, first);
  return off2 === off ? first : new Date(guess.getTime() - off2 * 60000);
}
/** [start, end) UTC instants covering clinic dates from..to (inclusive). */
const dayRange = (from, to, tz) => [startOfDay(from, tz), startOfDay(addDays(to, 1), tz)];
/** Adds `col >= start AND col < end` for a clinic date range on a UTC timestamp column. */
const whereLocalDates = (q, col, from, to, tz) => {
  const [a, b] = dayRange(from, to, tz);
  return q.where(col, '>=', a).where(col, '<', b);
};
/**
 * The offset changes of a time zone (daylight saving) from 6 years back to 2 years ahead: [{ at: Date, offset }],
 * the first entry being the offset before any change. Cached per zone for a day.
 */
const tzCache = new Map();
function tzSegments(tz) {
  const key = `${tz}|${new Date().toISOString().slice(0, 10)}`;
  if (tzCache.has(key)) return tzCache.get(key);
  const DAY = 86_400_000; const now = Date.now();
  let t = now - 6 * 366 * DAY; const end = now + 2 * 366 * DAY;
  let off = tzOffset(tz, new Date(t));
  const segs = [{ at: null, offset: off }];
  for (; t < end; t += DAY) {
    const next = tzOffset(tz, new Date(t + DAY));
    if (next !== off) {
      let lo = t; let hi = t + DAY; // the change happens in (lo, hi]: narrow it to the minute
      while (hi - lo > 60_000) { const mid = Math.floor((lo + hi) / 2); if (tzOffset(tz, new Date(mid)) === off) lo = mid; else hi = mid; }
      segs.push({ at: new Date(Math.floor(hi / 60_000) * 60_000), offset: next });
      off = next;
    }
  }
  tzCache.clear(); tzCache.set(key, segs);
  return segs;
}
/**
 * SQL expression turning a UTC timestamp into the clinic's local date. Each row uses the offset in force at its own
 * time (summer / winter time), so grouping by day or month matches the clinic's calendar all year.
 */
function localDateSql(col, tz) {
  const segs = tzSegments(tz || 'UTC');
  if (segs.length === 1) return knex.raw('DATE(DATE_ADD(??, INTERVAL ? MINUTE))', [col, segs[0].offset]);
  const whens = segs.slice(1).map(() => 'WHEN ?? < ? THEN ?').join(' ');
  const binds = [];
  segs.slice(1).forEach((sg, i) => binds.push(col, sg.at, segs[i].offset));
  return knex.raw(`DATE(DATE_ADD(??, INTERVAL (CASE ${whens} ELSE ? END) MINUTE))`, [col, ...binds, segs[segs.length - 1].offset]);
}

/** Clinic-local "HH:MM" and date of a UTC timestamp. */
function localTime(ts, tz) {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}` };
}

const STATUS_TONE = { pending: 'warning', confirmed: 'info', completed: 'success', cancelled: 'neutral', no_show: 'danger' };

function ageOf(dob, today) {
  if (!dob || !isIso(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let age = ty - y;
  if (tm < m || (tm === m && td < d)) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

/** wa.me wants digits only with the country code; local numbers (07…) are left as typed minus the leading zero. */
function waNumber(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits.slice(1);
  if (digits.startsWith('00')) return digits.slice(2);
  return digits;
}

/** Restricts a patients query to people with at least one appointment with the given doctor. */
function scopePatientsToDoctor(q, doctorId, col = 'patients.id') {
  if (!doctorId) return q;
  return q.whereExists(function exists() {
    this.select(knex.raw('1')).from('appointments as sa').whereRaw('sa.patient_id = ??', [col]).where('sa.doctor_id', doctorId);
  });
}

async function paginate(base, { page, perPage = 25 } = {}) {
  const [{ n }] = await base.clone().clearSelect().clearOrder().count({ n: '*' });
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = await base.clone().limit(perPage).offset((current - 1) * perPage);
  return { rows, meta: { total, page: current, pages, perPage } };
}

const likeTerm = (s) => `%${String(s).trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

// Names typed with or without hamza / taa marbuta / alef maqsura find each other ("احمد" ↔ "أحمد", "هبه" ↔ "هبة"),
// and every word may sit anywhere in the name ("محمد الخالدي" finds "محمد أحمد الخالدي").
const AR_FOLD = [['أ', 'ا'], ['إ', 'ا'], ['آ', 'ا'], ['ٱ', 'ا'], ['ة', 'ه'], ['ى', 'ي'], ['ؤ', 'و'], ['ئ', 'ي']];
const foldText = (s) => AR_FOLD.reduce((v, [a, b]) => v.split(a).join(b), String(s || '').replace(/[\u064B-\u0652\u0670\u0640]/g, ''));
const foldSql = (col) => AR_FOLD.reduce((sql, [a, b]) => `REPLACE(${sql}, '${a}', '${b}')`, col);
/**
 * Adds "the name matches" to a knex where-group: each word of `q`, folded, inside the folded column. `col` is a
 * column name written in the code (never user input).
 */
function nameMatch(w, col, q) {
  const words = foldText(q).trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return w;
  const ident = col.split('.').map((p) => `\`${p.replace(/[^A-Za-z0-9_]/g, '')}\``).join('.');
  return w.orWhere((x) => words.forEach((word) => x.whereRaw(`${foldSql(ident)} LIKE ?`, [likeTerm(word)])));
}

/** Resolves ?month= / ?from=&to= into a range (defaults to the current clinic month). */
function resolveRange(query, today) {
  const thisMonth = today.slice(0, 7);
  if (isIso(query.from) && isIso(query.to) && query.from <= query.to && daysBetween(query.from, query.to) <= 366 * 3) {
    return { from: query.from, to: query.to, month: '', custom: true };
  }
  const month = MONTH.test(query.month || '') ? query.month : thisMonth;
  return { ...monthBounds(month), month, custom: false };
}

module.exports = {
  isIso, addDays, addMonths, daysBetween, monthBounds, tzOffset, startOfDay, dayRange, whereLocalDates, localDateSql, localTime,
  STATUS_TONE, ageOf, waNumber, scopePatientsToDoctor, paginate, likeTerm, nameMatch, foldText, resolveRange, MONTH,
};
