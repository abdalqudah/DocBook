// Closing the site for maintenance (Platform admin → Maintenance, or MAINTENANCE=site|all in .env for emergencies).
//   scope "site"  the public pages (home, clinic websites, booking, sign-up) answer "under maintenance"; staff keep working
//   scope "all"   everything does, the clinics' staff pages too
// The platform admin's account always gets through (to finish the work and reopen), as do sign-in, password reset,
// the admin pages, payment / messaging callbacks from providers, and the health check. Every change is audited.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');

const KEY = 'maintenance';
const SCOPES = ['site', 'all'];
const ALWAYS = [/^\/(login|logout|forgot|reset|password|admin|healthz|hooks|pay\/hook|brand|theme\.css|favicon)(\/|$|\.)/, /^\/[a-z0-9-]+\/login$/,
  // the clinic's look on the maintenance and sign-in pages: its colours, logos, browser icon and fonts
  /^\/[a-z0-9-]+\/(theme\.css|logo|logo-square|favicon|brand\/(logo-dark|favicon)|fonts\/[^/]+)$/, /^\/m\/[a-z0-9-]+\/\d+$/];
const STAFF = /^\/(app|vendor|workspaces)(\/|$)/;

const clean = (v, n) => String(v || '').trim().slice(0, n);

async function state() {
  const env = String(process.env.MAINTENANCE || '').toLowerCase();
  if (SCOPES.includes(env)) return { on: true, scope: env, fromEnv: true, title_ar: '', title_en: '', message_ar: '', message_en: '' };
  return cache.remember('platform:maintenance', async () => {
    const row = await knex.main('platform_settings').where({ key: KEY }).first('value').catch(() => null);
    let v = {};
    try { v = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) || {} : {}; } catch { v = {}; }
    return { on: Boolean(v.on), scope: SCOPES.includes(v.scope) ? v.scope : 'site', title_ar: v.title_ar || '', title_en: v.title_en || '', message_ar: v.message_ar || '', message_en: v.message_en || '', since: v.since || null };
  }, 5_000);
}

async function save(ctx, input) {
  const before = await state();
  const value = {
    on: input.on === '1' || input.on === true, scope: SCOPES.includes(input.scope) ? input.scope : 'site',
    title_ar: clean(input.title_ar, 120), title_en: clean(input.title_en, 120), message_ar: clean(input.message_ar, 600), message_en: clean(input.message_en, 600),
  };
  value.since = value.on ? (before.on && before.since ? before.since : new Date().toISOString()) : null;
  await knex.main('platform_settings').insert({ key: KEY, value: JSON.stringify(value) }).onConflict('key').merge({ value: JSON.stringify(value), updated_at: new Date() });
  cache.forgetPrefix('platform:maintenance');
  await audit.record({ ...ctx, businessId: null }, value.on ? 'platform.maintenance_on' : 'platform.maintenance_off', { entityType: 'platform', oldValues: { on: before.on, scope: before.scope }, newValues: { on: value.on, scope: value.scope } });
  return value;
}

/** Is this request held back by maintenance? */
function blocked(st, req) {
  if (!st.on) return false;
  if (req.user && req.user.is_platform_admin) return false;
  const p = req.path;
  if (ALWAYS.some((re) => re.test(p))) return false;
  if (STAFF.test(p)) return st.scope === 'all';
  return true;
}

async function middleware(req, res, next) {
  try {
    const st = await state();
    if (!blocked(st, req)) {
      if (st.on && req.user && req.user.is_platform_admin) res.locals.maintenanceOn = st; // a reminder bar for the admin
      return next();
    }
    res.status(503).set({ 'Retry-After': '1800', 'Cache-Control': 'no-store' });
    const en = req.locale === 'en';
    const title = (en ? st.title_en || st.title_ar : st.title_ar || st.title_en) || req.t('maintenance.title');
    const message = (en ? st.message_en || st.message_ar : st.message_ar || st.message_en) || req.t('maintenance.message');
    if (req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/app/api/') || (req.get('accept') || '').startsWith('application/json')) {
      return res.json({ success: false, error: { code: 'MAINTENANCE', message } });
    }
    return res.page('pages/maintenance', { layout: 'auth', title, message, noindex: true });
  } catch (e) { return next(e); }
}

module.exports = { state, save, middleware, blocked, SCOPES };
