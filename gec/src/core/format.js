// Locale-aware formatting for views and e-mails. Arabic uses Latin digits (common in GEC's markets, easier to scan).
const tag = (locale) => (locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB');

function formatDate(value, locale = 'en', opts = { dateStyle: 'medium' }, timeZone) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(String(value).length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return '—';
  const o = { ...opts };
  if (String(value).length === 10) o.timeZone = 'UTC';
  else if (timeZone) o.timeZone = timeZone;
  return new Intl.DateTimeFormat(tag(locale), o).format(d);
}
const formatDateTime = (v, locale, tz) => formatDate(v, locale, { dateStyle: 'medium', timeStyle: 'short' }, tz);
const formatTime = (v, locale, tz) => formatDate(v, locale, { timeStyle: 'short' }, tz);

function formatMoney(amount, currency = 'USD', locale = 'en', digits) {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(tag(locale), { style: 'currency', currency: currency || 'USD', maximumFractionDigits: digits ?? (Number.isInteger(n) ? 0 : 2) }).format(n);
  } catch { return `${n.toLocaleString('en')} ${currency}`; }
}
const formatNumber = (n, locale = 'en', digits = 0) => (n === null || n === undefined || n === '' ? '—' : new Intl.NumberFormat(tag(locale), { maximumFractionDigits: digits }).format(Number(n)));
const formatPercent = (n, locale = 'en', digits = 0) => (n === null || n === undefined ? '—' : new Intl.NumberFormat(tag(locale), { style: 'percent', maximumFractionDigits: digits }).format(Number(n)));

/** "3 days ago" / "in 2 hours". */
function relative(value, locale = 'en', now = Date.now()) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  const sec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(sec);
  const rtf = new Intl.RelativeTimeFormat(tag(locale), { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(sec), 'second');
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(sec / (86400 * 30)), 'month');
  return rtf.format(Math.round(sec / (86400 * 365)), 'year');
}

const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (v) => { if (!v) return ''; const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? '' : `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const toDateTimeInput = (v) => { if (!v) return ''; const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? '' : `${toDateInput(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const today = () => toDateInput(new Date());
const daysBetween = (a, b = new Date()) => Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);

module.exports = { formatDate, formatDateTime, formatTime, formatMoney, formatNumber, formatPercent, relative, toDateInput, toDateTimeInput, today, daysBetween };
