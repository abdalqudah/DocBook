// Live agenda change feed — Server-Sent Events without a message broker.
// Works with several app processes (cPanel/Passenger may start more than one): every process polls the database
// for the clinics that have at least one open connection in THAT process, so a change made through any process
// reaches every browser within one poll. One poll per clinic per process, shared by all its connections.
//
// Version of a clinic = per (date, doctor) group of appointments from 7 days ago to 90 days ahead:
// COUNT(*) + BIT_XOR(CRC32(row fingerprint)). The fingerprint covers what the agenda shows (time, length, status,
// doctor, patient name, check-in / with-doctor, payment, updated_at), so any insert, delete or change — even one
// that does not touch updated_at — changes the group's value. Changed groups tell which dates/doctors to refresh.
const knex = require('../../db/knex');
const { clinicNow } = require('../clinic/scheduling');

const POLL_MS = Number(process.env.LIVE_POLL_MS) || 3000;
const HEARTBEAT_MS = 25_000;
const PAST_DAYS = 7;
const AHEAD_DAYS = 90;
const MAX_PER_USER = 5; // open live connections per user per process (tabs)

const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const asDate = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));

/** Signature of every (date, doctor) group of a clinic: Map "YYYY-MM-DD|doctorId" → "count:hash". */
async function snapshot(businessId, today, db = knex) {
  const rows = await db('appointments').where('business_id', businessId)
    .whereBetween('appointment_date', [addDays(today, -PAST_DAYS), addDays(today, AHEAD_DAYS)])
    .groupBy('appointment_date', 'doctor_id')
    .select('appointment_date as d', 'doctor_id as doc', db.raw('COUNT(*) as n'),
      db.raw("BIT_XOR(CRC32(CONCAT_WS('|', id, appointment_time, IFNULL(duration_minutes, ''), status, IFNULL(service_id, ''), patient_name, appointment_type, checked_in, with_doctor, payment_status, IFNULL(updated_at, '')))) as h"));
  const map = new Map();
  rows.forEach((r) => map.set(`${asDate(r.d)}|${r.doc || 0}`, `${r.n}:${r.h}`));
  return map;
}

/** Groups that differ between two snapshots → { dates:[…], doctorIds:[…] } (doctor 0 = unassigned). */
function diff(prev, next) {
  const dates = new Set(); const doctorIds = new Set();
  const mark = (k) => { const [d, doc] = k.split('|'); dates.add(d); doctorIds.add(Number(doc)); };
  next.forEach((v, k) => { if (prev.get(k) !== v) mark(k); });
  prev.forEach((v, k) => { if (!next.has(k)) mark(k); });
  return { dates: [...dates].sort(), doctorIds: [...doctorIds].sort((a, b) => a - b) };
}

/** Today's arrivals: who is checked in / with the doctor (for the doctor's "patient arrived" notice). */
async function arrivals(businessId, today, db = knex) {
  const rows = await db('appointments').where({ business_id: businessId, appointment_date: today }).whereNot('status', 'cancelled')
    .andWhere((w) => w.where('checked_in', true).orWhere('with_doctor', true)).select('id', 'doctor_id', 'patient_name', 'appointment_time', 'checked_in', 'with_doctor');
  const map = new Map();
  rows.forEach((r) => map.set(r.id, r));
  return map;
}

function newArrivals(prev, next) {
  const out = [];
  next.forEach((r, id) => {
    const p = prev.get(id);
    if (r.with_doctor && !(p && p.with_doctor)) out.push({ id, doctorId: r.doctor_id || 0, name: r.patient_name, time: r.appointment_time, kind: 'with_doctor' });
    else if (r.checked_in && !(p && p.checked_in) && !r.with_doctor) out.push({ id, doctorId: r.doctor_id || 0, name: r.patient_name, time: r.appointment_time, kind: 'checked_in' });
  });
  return out;
}

// ---------------------------------------------------------------- per-process hub
const clinics = new Map(); // businessId → { conns:Set, timer, snap, arr, today, timezone, busy }
let seq = 0;

function send(conn, event, data) {
  try {
    conn.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof conn.res.flush === 'function') conn.res.flush();
  } catch { /* closed */ }
}

async function poll(c, businessId) {
  if (c.busy) return;
  c.busy = true;
  try {
    const today = clinicNow(c.timezone).date;
    const snap = await snapshot(businessId, today);
    const dayChanged = c.today !== today;
    const d = c.snap && !dayChanged ? diff(c.snap, snap) : { dates: [], doctorIds: [] };
    let arr = c.arr;
    let fresh = [];
    if (!c.arr || dayChanged || d.dates.includes(today)) {
      arr = await arrivals(businessId, today);
      if (c.arr && !dayChanged) fresh = newArrivals(c.arr, arr);
    }
    c.snap = snap; c.arr = arr; c.today = today;
    if (!d.dates.length) return;
    c.conns.forEach((conn) => {
      const own = conn.doctorId;
      if (own && !d.doctorIds.includes(own)) return; // a doctor who sees only their own schedule
      const mine = own ? fresh.filter((a) => a.doctorId === own) : fresh;
      send(conn, 'appointments', { type: 'appointments', date: d.dates.length === 1 ? d.dates[0] : null, dates: d.dates, doctorIds: own ? [own] : d.doctorIds, arrivals: mine, today });
    });
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') console.error('[live] poll failed:', e.message); // eslint-disable-line no-console
  } finally {
    c.busy = false;
  }
}

/**
 * Registers an open SSE response. Returns false when the user already has too many open connections.
 * @param {{ businessId, userId, timezone, doctorId|null }} who
 */
function subscribe(who, res) {
  let c = clinics.get(who.businessId);
  const mine = c ? [...c.conns].filter((x) => x.userId === who.userId).length : 0;
  if (mine >= MAX_PER_USER) return false;
  if (!c) {
    c = { conns: new Set(), timer: null, snap: null, arr: null, today: null, timezone: who.timezone, busy: false };
    clinics.set(who.businessId, c);
    poll(c, who.businessId); // baseline
    c.timer = setInterval(() => poll(c, who.businessId), POLL_MS);
    if (c.timer.unref) c.timer.unref();
  }
  seq += 1;
  const conn = { id: seq, userId: who.userId, doctorId: who.doctorId || null, res };
  c.conns.add(conn);
  const beat = setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`); if (typeof res.flush === 'function') res.flush(); } catch { /* closed */ } }, HEARTBEAT_MS);
  if (beat.unref) beat.unref();
  const close = () => {
    clearInterval(beat);
    c.conns.delete(conn);
    if (!c.conns.size && clinics.get(who.businessId) === c) { clearInterval(c.timer); clinics.delete(who.businessId); }
  };
  res.on('close', close);
  return true;
}

const stats = () => ({ clinics: clinics.size, connections: [...clinics.values()].reduce((s, c) => s + c.conns.size, 0) });

module.exports = { snapshot, diff, arrivals, newArrivals, subscribe, stats, POLL_MS, HEARTBEAT_MS, MAX_PER_USER };
