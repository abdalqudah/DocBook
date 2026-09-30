// A doctor's private iCal subscription (/calendar/<token>.ics) — read by Google / Apple / Outlook calendar.
// Privacy: an event only carries the time, the word "Appointment" and the patient's first-name initial.
// No phone, no service, no notes, no medical data. Anyone with the address can read it, so it is off by default,
// can be turned off (row deleted) and rotated (new token, the old address stops working at once).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { randomToken, sha256 } = require('../../core/tokens');
const scheduling = require('../clinic/scheduling');
const ical = require('./ical');

const PAST_DAYS = 30;
const AHEAD_DAYS = 180;
const WORDS = { ar: { appt: 'موعد', blocked: 'وقت محجوز' }, en: { appt: 'Appointment', blocked: 'Blocked time' } };

// The token is kept encrypted (APP_KEY / SESSION_SECRET). A development install without either keeps it readable
// instead of failing — production always has SESSION_SECRET (config refuses to start without it).
const seal = (token) => { try { return secrets.encrypt(token); } catch { return `plain:${token}`; } };
const unseal = (v) => (String(v || '').startsWith('plain:') ? String(v).slice(6) : secrets.decrypt(v));

const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function forBusiness(businessId) {
  const rows = await knex('calendar_feeds').where({ business_id: businessId }).select('id', 'doctor_id', 'token_enc', 'locale', 'last_used_at', 'created_at');
  return new Map(rows.map((r) => [r.doctor_id, { ...r, token: unseal(r.token_enc) }]));
}

/** Turns the feed on (or rotates it): a new token, the previous address stops working. */
async function enable(ctx, doctorId, locale) {
  const token = randomToken(24);
  const row = { token_hash: sha256(token), token_enc: seal(token), locale: locale === 'en' ? 'en' : 'ar', created_by: ctx.userId || null, updated_at: new Date(), last_used_at: null };
  const had = await knex('calendar_feeds').where({ business_id: ctx.businessId, doctor_id: doctorId }).first('id');
  if (had) await knex('calendar_feeds').where({ id: had.id }).update(row);
  else await knex('calendar_feeds').insert({ business_id: ctx.businessId, doctor_id: doctorId, ...row });
  await audit.record(ctx, had ? 'calendar_feed.rotated' : 'calendar_feed.enabled', { entityType: 'doctor', entityId: doctorId });
  return token;
}

async function disable(ctx, doctorId) {
  const n = await knex('calendar_feeds').where({ business_id: ctx.businessId, doctor_id: doctorId }).del();
  if (n) await audit.record(ctx, 'calendar_feed.disabled', { entityType: 'doctor', entityId: doctorId });
}

const initial = (name) => { const first = String(name || '').trim().split(/\s+/)[0] || ''; return first ? `${Array.from(first)[0].toUpperCase()}.` : ''; };

/** The .ics body for a token, or null when the token is unknown. */
async function render(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  const feed = await knex('calendar_feeds as f').join('doctors as d', 'd.id', 'f.doctor_id').join('businesses as b', 'b.id', 'f.business_id')
    .where('f.token_hash', sha256(token)).first('f.id', 'f.business_id', 'f.doctor_id', 'f.locale', 'f.last_used_at', 'd.full_name', 'd.full_name_en', 'd.slot_duration_minutes', 'b.name as clinic_name', 'b.name_en as clinic_name_en', 'b.timezone');
  if (!feed) return null;
  const today = scheduling.clinicNow(feed.timezone).date;
  const rows = await knex('appointments as a').leftJoin('services as s', 's.id', 'a.service_id')
    .where({ 'a.business_id': feed.business_id, 'a.doctor_id': feed.doctor_id }).whereNot('a.status', 'cancelled')
    .whereBetween('a.appointment_date', [addDays(today, -PAST_DAYS), addDays(today, AHEAD_DAYS)])
    .orderBy([{ column: 'a.appointment_date' }, { column: 'a.appointment_time' }]).limit(5000)
    .select('a.id', 'a.appointment_date', 'a.appointment_time', 'a.appointment_type', 'a.patient_name', knex.raw('COALESCE(a.duration_minutes, s.duration_minutes, ?) as len', [feed.slot_duration_minutes || 30]));
  const w = WORDS[feed.locale] || WORDS.ar;
  const en = feed.locale === 'en';
  const events = rows.map((a) => {
    const [y, mo, d] = a.appointment_date.split('-').map(Number); const [h, mi] = a.appointment_time.split(':').map(Number);
    const startUtc = ical.wallToUtc({ y, mo, d, h, mi, s: 0 }, feed.timezone || 'UTC');
    const blocked = a.appointment_type === 'blocked';
    return { uid: `appt-${a.id}-${feed.business_id}@docbook`, startUtc, endUtc: startUtc + Number(a.len || 30) * 60000, summary: blocked ? w.blocked : `${w.appt} ${initial(a.patient_name)}`.trim() };
  });
  if (!feed.last_used_at || Date.now() - new Date(feed.last_used_at).getTime() > 3_600_000) await knex('calendar_feeds').where({ id: feed.id }).update({ last_used_at: new Date() });
  const clinic = (en && feed.clinic_name_en) || feed.clinic_name;
  const doctor = (en && feed.full_name_en) || feed.full_name;
  return ical.build({ name: `${clinic} · ${doctor}`, events });
}

module.exports = { forBusiness, enable, disable, render, initial };
