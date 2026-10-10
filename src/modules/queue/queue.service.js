// Waiting-room screens: a TV in the waiting room shows who goes in now, who is next and who is waiting, each with
// the doctor's room number (doctors.room). Each screen opens with its own secret link (/queue/<token>) — the TV is
// never signed in with a staff account; "New link" replaces a link shared by mistake (the old one stops at once).
//
//   board(screen, clinic)  → { voice, now, next, waiting[2], rooms[], sig } — what the screen shows, refreshed every 2 s
//
// Patients are shown as "Ahmad K." unless the clinic chooses full names for that screen.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { sha256 } = require('../../core/tokens');
const { E } = require('../../core/errors');
const { clinicNow } = require('../clinic/scheduling');

const ONLINE_MS = 60_000; // the screen refreshes every 2 s: "on now" when seen within a minute
const TOUCH_MS = 30_000;
const STYLES = ['short', 'full'];

async function list(businessId) {
  const rows = await knex('queue_screens').where({ business_id: businessId }).orderBy('id');
  const now = Date.now();
  return rows.map((k) => ({ ...k, online: Boolean(k.is_active && k.last_seen_at && now - new Date(k.last_seen_at).getTime() < ONLINE_MS) }));
}

async function get(ctx, id) {
  const k = await knex('queue_screens').where({ id: Number(id), business_id: ctx.businessId }).first();
  if (!k) throw E.notFound('Screen');
  return k;
}

const cleanName = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 80);
// The message in the middle of the top bar ("Welcome", "Happy Eid"…): one line of plain text, or none.
const cleanMessage = (v) => String(v || '').replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || null;
const isOn = (raw) => { const v = Array.isArray(raw) ? raw[raw.length - 1] : raw; return v === '1' || v === true || v === 'on'; }; // a checkbox posts a hidden "0" before it
const cleanStyle = (v) => (STYLES.includes(v) ? v : 'short');
// '' = every branch (null), 'main' = the main branch (0), an id = that active branch.
async function cleanBranch(businessId, v) {
  if (v === undefined || v === null || v === '') return null;
  if (v === 'main' || v === '0') return 0;
  return require('../clinic/branches.service').check(businessId, v); // eslint-disable-line global-require
}
const newToken = () => {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token_enc: secrets.encrypt(token), token_hash: sha256(token) };
};

async function create(ctx, input) {
  const name = cleanName(input.name);
  if (!name) throw E.validation({ name: 'Required.' });
  const row = { business_id: ctx.businessId, name, name_style: cleanStyle(input.name_style), voice: input.voice === '1' || input.voice === true, show_name: input.show_name === undefined ? true : isOn(input.show_name), message: cleanMessage(input.message), branch_id: await cleanBranch(ctx.businessId, input.branch_id), scope: ctx.centerId && input.scope === 'center' ? 'center' : 'clinic', created_by: ctx.userId || null, ...newToken() };
  const [id] = await knex('queue_screens').insert(row);
  await audit.record(ctx, 'queue.screen_created', { entityType: 'queue_screen', entityId: id, newValues: { name, name_style: row.name_style, branch_id: row.branch_id, voice: row.voice } });
  return id;
}

async function update(ctx, id, input) {
  const before = await get(ctx, id);
  const name = cleanName(input.name);
  if (!name) throw E.validation({ name: 'Required.' });
  const patch = { name, name_style: cleanStyle(input.name_style), voice: input.voice === '1' || input.voice === true, show_name: isOn(input.show_name), message: cleanMessage(input.message), is_active: input.is_active === '1' || input.is_active === true, branch_id: await cleanBranch(ctx.businessId, input.branch_id), scope: ctx.centerId && input.scope === 'center' ? 'center' : 'clinic', updated_at: new Date() };
  await knex('queue_screens').where({ id: before.id }).update(patch);
  await audit.record(ctx, 'queue.screen_updated', { entityType: 'queue_screen', entityId: before.id,
    oldValues: { name: before.name, name_style: before.name_style, voice: Boolean(before.voice), is_active: Boolean(before.is_active), branch_id: before.branch_id }, newValues: { ...patch, updated_at: undefined } });
}

async function regenerate(ctx, id) {
  const before = await get(ctx, id);
  await knex('queue_screens').where({ id: before.id }).update({ ...newToken(), last_seen_at: null, updated_at: new Date() });
  await audit.record(ctx, 'queue.screen_new_link', { entityType: 'queue_screen', entityId: before.id, newValues: { name: before.name } });
}

async function remove(ctx, id) {
  const before = await get(ctx, id);
  await knex('queue_screens').where({ id: before.id }).del();
  await audit.record(ctx, 'queue.screen_deleted', { entityType: 'queue_screen', entityId: before.id, oldValues: { name: before.name } });
}

function displayUrl(k, base) {
  const token = secrets.decrypt(k.token_enc);
  return token ? `${String(base).replace(/\/+$/, '')}/queue/${token}` : null;
}

async function byToken(token) {
  const t = String(token || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
  const k = await knex('queue_screens').where({ token_hash: sha256(t) }).first();
  return k && k.is_active ? k : null;
}

async function touch(k) {
  if (k.last_seen_at && Date.now() - new Date(k.last_seen_at).getTime() < TOUCH_MS) return;
  await knex('queue_screens').where({ id: k.id }).update({ last_seen_at: new Date() });
}

/** "Ahmad Khaled Saleh" → "Ahmad S."; "ليان عمر الخطيب" → "ليان خ." (first name + family initial, without "ال"). */
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '—';
  const last = parts[parts.length - 1].replace(/^ال(?=\S{2})/, '');
  return `${parts[0]} ${Array.from(last)[0]}.`;
}

/**
 * What the screen shows right now (today, this clinic, the screen's branch):
 *   now      the patient called in last (still with the doctor)
 *   next     the first patient waiting (checked in longest ago), with the doctor's room
 *   waiting  the two after them
 *   rooms    every room busy now (one patient per doctor)
 * sig changes whenever any of them changes: the screen then plays the chime.
 */
async function board(screen, clinic) {
  const today = clinicNow(clinic.timezone).date;
  const rows = await knex('appointments as a')
    .leftJoin('doctors as d', function j() { this.on('d.id', 'a.doctor_id').andOn('d.business_id', 'a.business_id'); })
    // the clinic (room) number the doctor works in today, else its usual one
    .leftJoin('doctor_day_rooms as dr', function j() { this.on('dr.doctor_id', 'a.doctor_id').andOnVal('dr.day', '=', today); })
    .where({ 'a.appointment_date': today, 'a.checked_in': true })
    // A medical centre's shared screen: every practice of the centre; otherwise this clinic only.
    .modify((q) => {
      if (screen.scope === 'center' && clinic.center_id) q.whereIn('a.business_id', knex('businesses').where({ center_id: clinic.center_id, status: 'active' }).select('id'));
      else q.where('a.business_id', clinic.id);
    })
    .whereIn('a.status', ['pending', 'confirmed'])
    .whereNot('a.appointment_type', 'blocked')
    .whereNull('a.doctor_finished_at')
    .modify((q) => {
      if (screen.scope === 'center' && clinic.center_id) return;
      if (screen.branch_id === 0) q.whereNull('a.branch_id');
      else if (screen.branch_id) q.where('a.branch_id', screen.branch_id);
    })
    .select('a.id', 'a.patient_name', 'a.with_doctor', 'a.called_at', 'a.arrived_at', 'a.appointment_time', 'a.doctor_id', 'a.appointment_type', 'a.payment_status',
      'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', knex.raw('CASE WHEN dr.id IS NULL THEN d.room ELSE dr.room END as room'));
  const name = screen.name_style === 'full' ? (n) => String(n || '').trim() || '—' : shortName;
  // Spoken name: the full name, or only the first name when the screen shows short names ("Ahmad S." reads badly).
  const say = (n) => (screen.name_style === 'full' ? String(n || '').trim() : String(n || '').trim().split(/\s+/)[0] || '');
  const show = (a) => a && ({ id: a.id, name: name(a.patient_name), say: say(a.patient_name), room: a.room || null, doctor: a.doctor_name || null, doctorEn: a.doctor_name_en || null });
  const inside = rows.filter((a) => a.with_doctor).sort((x, y) => (new Date(y.called_at || 0) - new Date(x.called_at || 0)) || (y.id - x.id));
  const queue = rows.filter((a) => !a.with_doctor)
    .sort((x, y) => (new Date(x.arrived_at || 0) - new Date(y.arrived_at || 0)) || String(x.appointment_time).localeCompare(String(y.appointment_time)));
  const out = { header: { showName: screen.show_name !== false && screen.show_name !== 0, message: screen.message || '' }, voice: Boolean(screen.voice), now: show(inside[0]) || null, next: show(queue[0]) || null, waiting: queue.slice(1, 3).map(show), more: Math.max(0, queue.length - 3), rooms: inside.map(show) };
  out.sig = [inside.map((a) => a.id).join('.'), queue.slice(0, 3).map((a) => a.id).join('.')].join('|');
  return out;
}

module.exports = { cleanMessage, ONLINE_MS, STYLES, list, get, create, update, regenerate, remove, displayUrl, byToken, touch, shortName, board };
