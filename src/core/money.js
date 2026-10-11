// Currency precision. DocBook's default currency (JOD) and other Gulf currencies use 3 decimals.
const THREE_DECIMALS = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'LYD', 'IQD']);
const ZERO_DECIMALS = new Set(['JPY', 'KRW', 'IQD_']);

const decimalsOf = (currency) => {
  const c = String(currency || '').toUpperCase();
  if (THREE_DECIMALS.has(c)) return 3;
  if (ZERO_DECIMALS.has(c)) return 0;
  return 2;
};

/** Rounds to the currency's precision (half away from zero). */
function round(value, currency) {
  const d = decimalsOf(currency);
  const f = 10 ** d;
  const n = Number(value) || 0;
  return (Math.sign(n) * Math.round(Math.abs(n) * f + 1e-9)) / f;
}

const FIRST = ['JOD', 'USD', 'EUR', 'GBP', 'SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR', 'EGP', 'IQD', 'LBP', 'SYP', 'TRY', 'MAD', 'TND', 'DZD', 'LYD'];
// the region's currencies first, then every other ISO currency (a clinic anywhere)
let ALL = [];
try { ALL = Intl.supportedValuesOf('currency'); } catch { ALL = []; }
const CURRENCIES = [...new Set([...FIRST, ...ALL])];

module.exports = { decimalsOf, round, CURRENCIES };
