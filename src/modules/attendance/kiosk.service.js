// Door screens ("kiosks"): a tablet or PC at the clinic door shows the attendance QR full-screen.
// Each screen opens with its own secret link (/kiosk/<token>) — the device is never signed in with a staff
// account, and a lost link is replaced with "New link" (the old one stops at once). The QR it shows is the
// clinic's rotating HMAC code (attendance.service), so what a phone scans is the same everywhere.
// The screen reports in with every refresh (last seen + network address), which also powers the optional
// "same network" rule: a scan is accepted only from the network of a screen that is on right now.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { sha256 } = require('../../core/tokens');
const { E } = require('../../core/errors');

const ONLINE_MS = 3 * 60_000; // a screen that refreshed within 3 minutes is "on screen now"
const NETWORK_MS = 15 * 60_000; // screens seen within 15 minutes define the clinic network
const TOUCH_MS = 60_000; // write "last seen" at most once a minute

async function list(businessId) {
  const rows = await knex('attendance_kiosks').where({ business_id: businessId }).orderBy('id');
  const now = Date.now();
  return rows.map((k) => ({ ...k, online: Boolean(k.is_active && k.last_seen_at && now - new Date(k.last_seen_at).getTime() < ONLINE_MS) }));
}

async function get(ctx, id) {
  const k = await knex('attendance_kiosks').where({ id: Number(id), business_id: ctx.businessId }).first();
  if (!k) throw E.notFound('Screen');
  return k;
}

const cleanName = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 120);
const newToken = () => {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token, display_token_enc: secrets.encrypt(token), display_token_hash: sha256(token) };
};

async function create(ctx, { name }) {
  const clean = cleanName(name);
  if (!clean) throw E.validation({ name: 'Required.' });
  const { display_token_enc: enc, display_token_hash: hash } = newToken();
  const [id] = await knex('attendance_kiosks').insert({ business_id: ctx.businessId, name: clean, display_token_enc: enc, display_token_hash: hash, created_by: ctx.userId });
  await audit.record(ctx, 'attendance.screen_created', { entityType: 'attendance_kiosk', entityId: id, newValues: { name: clean } });
  return id;
}

async function update(ctx, id, { name, is_active: isActive }) {
  const before = await get(ctx, id);
  const patch = { is_active: Boolean(isActive), updated_at: new Date() };
  if (name !== undefined) { patch.name = cleanName(name); if (!patch.name) throw E.validation({ name: 'Required.' }); }
  await knex('attendance_kiosks').where({ id: before.id }).update(patch);
  await audit.record(ctx, 'attendance.screen_updated', { entityType: 'attendance_kiosk', entityId: before.id, oldValues: { name: before.name, is_active: Boolean(before.is_active) }, newValues: { name: patch.name || before.name, is_active: patch.is_active } });
}

/** New secret link (e.g. the old one was shared by mistake): the old link stops working immediately. */
async function regenerate(ctx, id) {
  const before = await get(ctx, id);
  const { display_token_enc: enc, display_token_hash: hash } = newToken();
  await knex('attendance_kiosks').where({ id: before.id }).update({ display_token_enc: enc, display_token_hash: hash, last_seen_at: null, last_ip: null, updated_at: new Date() });
  await audit.record(ctx, 'attendance.screen_new_link', { entityType: 'attendance_kiosk', entityId: before.id, newValues: { name: before.name } });
}

async function remove(ctx, id) {
  const before = await get(ctx, id);
  await knex('attendance_kiosks').where({ id: before.id }).del();
  await audit.record(ctx, 'attendance.screen_deleted', { entityType: 'attendance_kiosk', entityId: before.id, oldValues: { name: before.name } });
}

/** The secret link that opens a screen. base = an address the door device can reach (see phoneBase). */
function displayUrl(k, base) {
  const token = secrets.decrypt(k.display_token_enc);
  return token ? `${String(base).replace(/\/+$/, '')}/kiosk/${token}` : null;
}

/** The active screen behind a secret link, or null. */
async function byDisplayToken(token) {
  const t = String(token || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
  const k = await knex('attendance_kiosks').where({ display_token_hash: sha256(t) }).first();
  return k && k.is_active ? k : null;
}

/** Records that the screen is showing the code, and from which network. */
async function touch(k, ip) {
  const addr = normIp(ip);
  if (k.last_seen_at && Date.now() - new Date(k.last_seen_at).getTime() < TOUCH_MS && k.last_ip === addr) return;
  await knex('attendance_kiosks').where({ id: k.id }).update({ last_seen_at: new Date(), last_ip: addr ? addr.slice(0, 64) : null });
}

// ---------------------------------------------------------------- network rule
function normIp(ip) { return ip ? String(ip).replace(/^::ffff:/i, '').trim() : ''; }
function isPrivateIp(ip) {
  const a = normIp(ip);
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) || a === '::1' || /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a);
}

/**
 * Is a phone at this address on the clinic's network? Compared with the screens shown in the last 15 minutes:
 * same public address (clinic Wi-Fi behind one internet connection), or both on a private network (DocBook runs
 * on a clinic PC and the phone is on its Wi-Fi). { known: false } when no screen is on — nothing to compare with.
 */
async function networkCheck(businessId, ip, now = Date.now()) {
  const screens = await knex('attendance_kiosks').where({ business_id: businessId, is_active: true }).where('last_seen_at', '>=', new Date(now - NETWORK_MS)).select('last_ip');
  const addrs = screens.map((s) => normIp(s.last_ip)).filter(Boolean);
  if (!addrs.length) return { known: false, same: true };
  const phone = normIp(ip);
  const same = addrs.some((a) => a === phone || (isPrivateIp(a) && isPrivateIp(phone)));
  return { known: true, same };
}

module.exports = { ONLINE_MS, list, get, create, update, regenerate, remove, displayUrl, byDisplayToken, touch, networkCheck, normIp, isPrivateIp };
