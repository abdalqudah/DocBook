// Countries on the platform: a clinic in Saudi Arabia sees the drug warehouses, reps and clinics of Saudi Arabia.
// A record without a country (older vendors, clinics before their country was set) is shown everywhere.
const CODE = /^[A-Z]{2}$/;
const clean = (v) => { const c = String(v || '').trim().toUpperCase(); return CODE.test(c) && !['XX', 'T1', 'ZZ'].includes(c) ? c : null; };

/** Narrows a query to `country` (ISO 3166 alpha-2) on `col`, keeping rows without a country. No country: unchanged. */
function inCountry(q, col, country) {
  const c = clean(country);
  if (!c) return q;
  return q.where((w) => w.whereNull(col).orWhere(col, '').orWhere(col, c));
}

/** The visitor's country from the proxy in front of the site (Cloudflare and others add it), or null. */
const ofRequest = (req) => clean(req && req.headers && (req.headers['cf-ipcountry'] || req.headers['x-country-code'] || req.headers['x-vercel-ip-country'] || req.headers['x-geo-country']));

module.exports = { clean, inCountry, ofRequest };
