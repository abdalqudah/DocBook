const { decimalsOf } = require('./money');

const numLocale = (locale) => (locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US');

/**
 * A calendar date ('YYYY-MM-DD', or a Date at exactly 00:00 UTC built from one) is shown as is. A moment in time (a
 * timestamp) is shown in the clinic's time zone `tz` — 01:30 on the 3rd in Amman is the 3rd, not the 2nd at 22:30.
 */
function formatDate(value, locale = 'en', opts = { year: 'numeric', month: 'short', day: 'numeric' }, tz = null) {
  if (!value) return '—';
  const isDay = typeof value === 'string' && value.length === 10;
  const d = value instanceof Date ? value : new Date(isDay ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return '—';
  const calendar = isDay || (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0);
  let zone = 'UTC';
  if (!calendar && tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); zone = tz; } catch { zone = 'UTC'; } } // eslint-disable-line no-new
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-ca-gregory-nu-latn' : 'en-GB', { ...opts, timeZone: zone }).format(d);
}

function formatMonth(key, locale = 'en') {
  if (!key || key === 'all') return key === 'all' ? (locale === 'ar' ? 'كل الفترات' : 'All time') : '—';
  return formatDate(`${key}-01`, locale, { year: 'numeric', month: 'long' });
}

/** Amount with currency code (e.g. "1,250.500 JOD"). Precision follows the currency. */
function formatMoney(amount, currency = 'USD', locale = 'en') {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '—';
  const d = decimalsOf(currency);
  const n = Number(amount);
  const s = new Intl.NumberFormat(numLocale(locale), { minimumFractionDigits: Number.isInteger(n) ? 0 : d, maximumFractionDigits: d }).format(n);
  return `${s} ${currency}`;
}

/** Amount without the currency code (tables show the code once in the header). */
function formatAmount(amount, currency = 'USD', locale = 'en') {
  if (amount === null || amount === undefined) return '—';
  const d = decimalsOf(currency);
  return new Intl.NumberFormat(numLocale(locale), { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(amount) || 0);
}

/** Compact money for KPI tiles (1.2K, 3.4M). */
function formatCompact(amount, currency = 'USD', locale = 'en') {
  if (amount === null || amount === undefined) return '—';
  const n = Number(amount) || 0;
  if (Math.abs(n) < 10000) return formatMoney(n, currency, locale); // formatMoney keeps the currency's own decimals
  return `${new Intl.NumberFormat(numLocale(locale), { notation: 'compact', maximumFractionDigits: 1 }).format(n)} ${currency}`;
}

function formatNumber(n, locale = 'en', maxDigits = 2) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat(numLocale(locale), { maximumFractionDigits: maxDigits }).format(Number(n) || 0);
}

function formatPercent(n, locale = 'en', digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return `${new Intl.NumberFormat(numLocale(locale), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(n))}%`;
}

function toDateInput(value) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => new Date().toISOString().slice(0, 7);

module.exports = { formatDate, formatMonth, formatMoney, formatAmount, formatCompact, formatNumber, formatPercent, toDateInput, today, currentMonth };
