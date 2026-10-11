// Who is active on the platform and from where (Admin → Activity): one row per signed-in account, refreshed at most
// once a minute while it is used — when, which clinic / warehouse, the IP address, the country (from the proxy's header
// when it sends one, else looked up from the IP on the Activity page when the admin turned that on) and the device.
const knex = require('../../db/knex');
const region = require('../../core/region');

const EVERY_MS = 60_000;
const seen = new Map(); // user id → last write (ms), so a busy page writes once a minute
const ONLINE_MIN = 5;

const kindOf = (req) => {
  if (req.user && req.user.is_platform_admin && req.originalUrl.startsWith('/admin')) return 'admin';
  if (req.originalUrl.startsWith('/vendor')) return 'vendor';
  if (req.originalUrl.startsWith('/app')) return 'clinic';
  return 'other';
};

/** Middleware: records the signed-in account's visit (never blocks the page, never fails it). */
function middleware(req, res, next) {
  const u = req.user;
  if (u && req.method === 'GET' && !/^\/(api|hooks|healthz)/.test(req.path)) {
    const now = Date.now();
    const last = seen.get(u.id) || { at: 0, country: null };
    const country = region.ofRequest(req);
    // once a minute, or at once when this visit tells a country not known yet
    if (now - last.at >= EVERY_MS || (country && country !== last.country)) {
      seen.set(u.id, { at: now, country: country || last.country });
      if (seen.size > 50_000) seen.clear();
      const kind = kindOf(req);
      const row = {
        user_id: u.id, kind, business_id: kind === 'clinic' ? (u.last_business_id || null) : null, vendor_id: null,
        last_seen_at: new Date(now), ip: String(req.ip || '').slice(0, 64) || null, country,
        user_agent: String(req.get('user-agent') || '').slice(0, 255) || null, path: String(req.path || '').slice(0, 190),
      };
      const merge = { ...row }; delete merge.user_id;
      if (!row.country) delete merge.country; // keep the last known country when this request has none
      if (kind === 'other') { delete merge.kind; delete merge.business_id; }
      knex('platform_activity').insert(row).onConflict('user_id').merge(merge).catch(() => {});
    }
  }
  next();
}

/** A short device label from the user agent: "Chrome · Windows". */
function device(ua) {
  const s = String(ua || '');
  const b = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : '';
  const o = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return [b, o].filter(Boolean).join(' · ') || '—';
}

/**
 * The page: counts (online now, today, this week), by country, and the accounts seen in the period.
 * filters: period ('online' | 'day' | 'week' | 'month'), country, kind.
 */
async function overview(f = {}, now = new Date()) {
  const since = (mins) => new Date(now.getTime() - mins * 60_000);
  const PERIOD = { online: ONLINE_MIN, day: 24 * 60, week: 7 * 24 * 60, month: 30 * 24 * 60 };
  const period = PERIOD[f.period] ? f.period : 'day';
  const placeCountry = knex.raw('COALESCE(a.country, p.country)');
  const base = () => knex('platform_activity as a').leftJoin('ip_places as p', 'p.ip', 'a.ip');
  const [online, today, week, byCountry] = await Promise.all([
    base().where('a.last_seen_at', '>=', since(ONLINE_MIN)).count({ n: '*' }).first(),
    base().where('a.last_seen_at', '>=', since(24 * 60)).count({ n: '*' }).first(),
    base().where('a.last_seen_at', '>=', since(7 * 24 * 60)).count({ n: '*' }).first(),
    base().where('a.last_seen_at', '>=', since(PERIOD[period])).groupByRaw('COALESCE(a.country, p.country)').select(knex.raw('COALESCE(a.country, p.country) as country')).count({ n: '*' }).orderBy('n', 'desc'),
  ]);
  const q = base().leftJoin('users as u', 'u.id', 'a.user_id').leftJoin('businesses as b', 'b.id', 'a.business_id')
    .leftJoin('vendor_users as vu', 'vu.user_id', 'a.user_id').leftJoin('vendors as v', 'v.id', 'vu.vendor_id')
    .where('a.last_seen_at', '>=', since(PERIOD[period]))
    .select('a.*', 'u.name as user_name', 'u.email as user_email', 'b.name as clinic_name', 'b.country as clinic_country', 'b.city as clinic_city',
      'v.name as vendor_name', 'p.city as ip_city', knex.raw('COALESCE(a.country, p.country) as place_country'))
    .orderBy('a.last_seen_at', 'desc').limit(500);
  if (/^[A-Z]{2}$/.test(String(f.country || ''))) q.where(placeCountry, f.country);
  if (['clinic', 'vendor', 'admin', 'other'].includes(f.kind)) q.where('a.kind', f.kind);
  const rows = (await q).map((r) => ({ ...r, online: new Date(r.last_seen_at) >= since(ONLINE_MIN), device: device(r.user_agent) }));
  // one row per account (a rep in two vendors would repeat)
  const uniq = []; const ids = new Set();
  rows.forEach((r) => { if (!ids.has(r.user_id)) { ids.add(r.user_id); uniq.push(r); } });
  return {
    period, counts: { online: Number(online.n), today: Number(today.n), week: Number(week.n) },
    countries: byCountry.map((r) => ({ code: r.country || null, n: Number(r.n) })), rows: uniq,
  };
}

/**
 * Looks up the country and city of up to `max` addresses not known yet (ipwho.is, HTTPS, no key) — only when the
 * platform admin turned it on (Admin → Platform settings) and pressed the button. Private addresses are skipped.
 */
const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80|::ffff:(10\.|127\.|192\.168\.))/i;
let fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
const setFetch = (fn) => { fetcher = fn; };
async function locate(max = 40) {
  const ips = await knex('platform_activity as a').leftJoin('ip_places as p', 'p.ip', 'a.ip').whereNotNull('a.ip').whereNull('p.ip')
    .orderBy('a.last_seen_at', 'desc').limit(max * 2).pluck('a.ip');
  let done = 0;
  for (const ip of [...new Set(ips)].filter((x) => !PRIVATE.test(x)).slice(0, max)) { // eslint-disable-line no-restricted-syntax
    try {
      const res = await fetcher(`https://ipwho.is/${encodeURIComponent(ip.replace(/^::ffff:/, ''))}?fields=success,country_code,city`); // eslint-disable-line no-await-in-loop
      const d = await res.json(); // eslint-disable-line no-await-in-loop
      const row = { ip, country: d && d.success ? region.clean(d.country_code) : null, city: d && d.success ? String(d.city || '').slice(0, 120) || null : null, looked_up_at: new Date() };
      await knex('ip_places').insert(row).onConflict('ip').merge(row); // eslint-disable-line no-await-in-loop
      done += 1;
    } catch { /* next one */ }
  }
  return done;
}

module.exports = { middleware, overview, locate, device, setFetch, ONLINE_MIN };
