// Staff presence ("last seen") and personal team preferences.
// Every /app page load and a light heartbeat from the open tab (public/js/teamops.js, ~60 s while visible) store
// the member's last_seen_at for the current clinic. "Online" is derived when read (seen in the last 2 minutes), so
// a closed tab simply ages into "last seen 5 min ago". Privacy: presence is only ever read for members of the same
// clinic, and a member who hides their presence is neither recorded nor shown (their row is removed).
const knex = require('../../db/knex');
const audit = require('../../core/audit');

const ONLINE_MS = 2 * 60 * 1000;
const TOUCH_EVERY_MS = 30 * 1000; // page loads closer together than this don't write again

const DEFAULT_PREFS = { sound_enabled: true, presence_hidden: false };

async function prefs(userId) {
  const row = await knex('team_user_prefs').where({ user_id: userId }).first('sound_enabled', 'presence_hidden');
  return row ? { sound_enabled: Boolean(row.sound_enabled), presence_hidden: Boolean(row.presence_hidden) } : { ...DEFAULT_PREFS };
}

async function savePrefs(ctx, input = {}) {
  const on = (v) => v === true || v === '1' || v === 'on' || v === 1;
  const next = { sound_enabled: on(input.sound_enabled), presence_hidden: on(input.presence_hidden) };
  const before = await prefs(ctx.userId);
  await knex('team_user_prefs').insert({ user_id: ctx.userId, ...next }).onConflict('user_id').merge({ ...next, updated_at: new Date() });
  if (next.presence_hidden) await knex('user_presence').where({ user_id: ctx.userId }).del(); // forget where they were seen, everywhere
  if (before.presence_hidden !== next.presence_hidden) {
    await audit.record(ctx, 'presence.visibility', { entityType: 'user', entityId: ctx.userId, oldValues: { hidden: before.presence_hidden }, newValues: { hidden: next.presence_hidden } });
  }
  return next;
}

// Small in-process memo so a burst of page loads writes once (keyed by clinic + user).
const lastTouch = new Map();

/** Records that ctx.userId is active in ctx.businessId now (unless they hide their presence). */
async function touch(ctx, { force = false } = {}) {
  if (!ctx || !ctx.businessId || !ctx.userId) return false;
  const key = `${ctx.businessId}:${ctx.userId}`;
  const now = Date.now();
  if (!force && lastTouch.has(key) && now - lastTouch.get(key) < TOUCH_EVERY_MS) return false;
  lastTouch.set(key, now);
  if (lastTouch.size > 5000) lastTouch.clear();
  if ((await prefs(ctx.userId)).presence_hidden) return false;
  await knex('user_presence').insert({ business_id: ctx.businessId, user_id: ctx.userId, last_seen_at: new Date(now) })
    .onConflict(['business_id', 'user_id']).merge({ last_seen_at: new Date(now) });
  return true;
}

/** Express middleware: touch presence on /app page loads (never blocks or fails the request). */
function middleware(req, res, next) {
  if (req.method === 'GET' && req.ctx && req.ctx.businessId) touch(req.ctx).catch((e) => console.error('[teamops] presence:', e.message)); // eslint-disable-line no-console
  next();
}

/**
 * Presence of the members of the viewer's clinic: { [userId]: { online, lastSeenAt, hidden } }.
 * The viewer must be a member of `ctx.businessId` (req.ctx guarantees it); nothing from other clinics is read.
 */
async function forClinic(ctx, userIds = null, now = Date.now()) {
  const q = knex('memberships as m').where({ 'm.business_id': ctx.businessId })
    .leftJoin('user_presence as p', function j() { this.on('p.user_id', 'm.user_id').andOn('p.business_id', 'm.business_id'); })
    .leftJoin('team_user_prefs as pr', 'pr.user_id', 'm.user_id')
    .select('m.id as membership_id', 'm.user_id', 'p.last_seen_at', 'pr.presence_hidden');
  if (userIds) q.whereIn('m.user_id', userIds.length ? userIds : [0]);
  const rows = await q;
  const out = {};
  rows.forEach((r) => {
    const hidden = Boolean(r.presence_hidden) && r.user_id !== ctx.userId;
    const seen = !hidden && r.last_seen_at ? new Date(r.last_seen_at) : null;
    out[r.user_id] = { membershipId: r.membership_id, hidden, lastSeenAt: seen, online: Boolean(seen && now - seen.getTime() < ONLINE_MS) };
  });
  return out;
}

/** "online" / "last seen 5 min ago" / "last seen 3 Oct" in the viewer's language. */
function label(p, t, locale = 'ar', now = Date.now()) {
  if (!p || p.hidden) return t('presence.hidden');
  if (p.online) return t('presence.online');
  if (!p.lastSeenAt) return t('presence.never');
  const diff = Math.max(0, now - new Date(p.lastSeenAt).getTime());
  const rtf = new Intl.RelativeTimeFormat(locale === 'en' ? 'en' : 'ar', { numeric: 'auto', style: 'long' });
  const min = Math.round(diff / 60000);
  let rel;
  if (min < 60) rel = rtf.format(-Math.max(1, min), 'minute');
  else if (min < 24 * 60) rel = rtf.format(-Math.round(min / 60), 'hour');
  else if (min < 7 * 24 * 60) rel = rtf.format(-Math.round(min / 1440), 'day');
  else rel = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', { day: 'numeric', month: 'short' }).format(new Date(p.lastSeenAt));
  return t('presence.last_seen', { when: rel });
}

module.exports = { ONLINE_MS, DEFAULT_PREFS, prefs, savePrefs, touch, middleware, forClinic, label };
