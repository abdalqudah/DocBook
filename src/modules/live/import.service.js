// Import appointments from Google Calendar / Outlook / Apple Calendar (iCal .ics file or private iCal address).
// Flow: read the source → expand events in the chosen range (ical.expand) → plan() marks each row (patient match,
// doctor, conflicts) for the preview → commit() imports the selected rows in one transaction (one savepoint per row,
// so a refused row never blocks the others) and returns what was imported / skipped with reasons.
// Rules: never double-book a doctor (real interval overlap against every non-cancelled appointment/block, under the
// same named slot lock as scheduling.withSlot); times outside working hours / days off only with the explicit
// override; past times are skipped; an event is imported once per clinic (external_uid, unique index).
const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const http = require('http');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError } = require('../../core/errors');
const httpCore = require('../../core/http');
const scheduling = require('../clinic/scheduling');
const appts = require('../clinic/appointments.service');
const { parseWh } = require('../clinic/doctors.service');
const ical = require('./ical');

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ROWS = 400;
const T = scheduling.timeToMinutes;

const fail = (code, message, status = 422) => new AppError(code, message, status);

// ---------------------------------------------------------------- reading the source
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    if (process.env.INTEGRATIONS_ALLOW_PRIVATE !== 'true' && list.some((a) => httpCore.isPrivateIp(a.address))) return callback(new httpCore.BlockedError(`Blocked private address for ${hostname}`));
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/** Downloads a private iCal address (https only, private networks blocked, 5 MB, 15 s, up to 3 redirects). */
function fetchCalendar(rawUrl, redirects = 3, deadline = Date.now() + FETCH_TIMEOUT_MS) {
  const input = String(rawUrl || '').trim().replace(/^webcals?:\/\//i, 'https://');
  const check = httpCore.validateUrl(input);
  if (check.error) return Promise.reject(fail('CAL_URL_INVALID', check.error));
  const u = check.url;
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const left = Math.max(1000, deadline - Date.now());
    const req = lib.get(u, { lookup: safeLookup, timeout: left, headers: { 'user-agent': 'DocBook-Calendar-Import/1.0', accept: 'text/calendar, */*;q=0.5' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(fail('CAL_FETCH_FAILED', 'Too many redirects.', 502));
        return resolve(fetchCalendar(new URL(res.headers.location, u).toString(), redirects - 1, deadline));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(fail('CAL_FETCH_FAILED', `The calendar server answered ${res.statusCode}.`, 502)); }
      if (Number(res.headers['content-length']) > MAX_BYTES) { res.destroy(); return reject(fail('CAL_TOO_BIG', 'The calendar is larger than 5 MB.')); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { res.destroy(); reject(fail('CAL_TOO_BIG', 'The calendar is larger than 5 MB.')); } else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', (e) => reject(fail('CAL_FETCH_FAILED', e.message, 502)));
      return undefined;
    });
    const timer = setTimeout(() => req.destroy(fail('CAL_TIMEOUT', 'The calendar server did not answer in time.', 502)), left);
    req.on('close', () => clearTimeout(timer));
    req.on('timeout', () => req.destroy(fail('CAL_TIMEOUT', 'The calendar server did not answer in time.', 502)));
    req.on('error', (e) => reject(e instanceof AppError ? e : e instanceof httpCore.BlockedError ? fail('CAL_URL_INVALID', 'This address is not reachable from this server.') : fail('CAL_FETCH_FAILED', e.message, 502)));
  });
}

/** Text of an uploaded file or a downloaded address; checks it is an iCalendar. */
async function readSource({ file, url }) {
  let text;
  if (file && file.buffer && file.buffer.length) {
    if (file.buffer.length > MAX_BYTES) throw fail('CAL_TOO_BIG', 'The calendar is larger than 5 MB.');
    text = file.buffer.toString('utf8');
  } else if (url && String(url).trim()) text = await fetchCalendar(url);
  else throw fail('CAL_SOURCE_MISSING', 'Choose a calendar file or paste its address.');
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 5000))) throw fail('CAL_NOT_ICS', 'This is not an iCalendar (.ics) file.');
  return text;
}

// ---------------------------------------------------------------- recognising patients and doctors
/** Phone-like numbers in a text: 7–15 digits, optional + / 00 prefix, spaces and dashes allowed. */
function extractPhones(text) {
  const out = [];
  String(text || '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/(?:\+|00)?\d[\d\s\-().]{5,18}\d/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15 && !/^(19|20)\d{6}$/.test(digits)) out.push({ raw: m.trim(), phone: (m.trim().startsWith('+') ? '+' : '') + digits });
    return m;
  });
  return out;
}
const phoneKey = (p) => String(p || '').replace(/\D/g, '').slice(-9);

/** Patient name from an event title: phone numbers and leftover separators removed. */
function nameFromTitle(summary, phones) {
  let s = String(summary || '');
  phones.forEach((p) => { s = s.split(p.raw).join(' '); });
  s = s.replace(/[٠-٩\d]{6,}/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–—|:,.·/]+|[\s\-–—|:,.·/]+$/g, '').trim();
  return s.slice(0, 190);
}

function keywordsOf(value) {
  return String(value || '').split(/[,،\n]/).map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 2);
}

/** Pure rule used by the preview and the import: why a time cannot be booked for a doctor (null = fine). */
function checkSlot({ date, time, minutes }, { workingHours, dayOff = false, busy = [], today, nowMinutes = 0 }) {
  const start = T(time); const end = start + minutes;
  if (date < today || (date === today && start <= nowMinutes)) return 'past';
  if (busy.some(([s, e]) => scheduling.overlaps(start, end, s, e))) return 'conflict';
  const day = scheduling.normalizeDayConfig(workingHours ? workingHours[scheduling.dayKeyOf(date)] : null);
  if (dayOff || !day.enabled) return 'outside_hours';
  const inShift = day.shifts.some((sh) => start >= T(sh.start) && end <= T(sh.end));
  const inBreak = day.breaks.some((b) => scheduling.overlaps(start, end, T(b.start), T(b.end)));
  if (!inShift || inBreak) return 'outside_hours';
  return null;
}

const storedUid = (key) => (String(key).length > 190 ? `h:${crypto.createHash('sha1').update(String(key)).digest('hex')}` : String(key));
const clampMinutes = (m) => (Number.isInteger(m) && m > 0 ? Math.min(scheduling.MAX_BLOCK_MINUTES, Math.max(scheduling.MIN_BLOCK_MINUTES, m)) : null);

async function loadContext(ctx, from, to, db = knex) {
  const doctors = await db('doctors').where({ business_id: ctx.businessId, is_active: true }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }])
    .select('id', 'full_name', 'full_name_en', 'color', 'working_hours', 'slot_duration_minutes');
  const offRows = await db('doctor_days_off').where({ business_id: ctx.businessId }).whereBetween('off_date', [from, to]).select('doctor_id', 'off_date');
  const booked = await db('appointments as a').leftJoin('services as s', 's.id', 'a.service_id').leftJoin('doctors as d', 'd.id', 'a.doctor_id')
    .where('a.business_id', ctx.businessId).whereBetween('a.appointment_date', [from, to]).whereNot('a.status', 'cancelled').whereNotNull('a.doctor_id')
    .select('a.doctor_id', 'a.appointment_date', 'a.appointment_time', db.raw('COALESCE(a.duration_minutes, s.duration_minutes, d.slot_duration_minutes, 30) as len'));
  const off = new Set(offRows.map((r) => `${r.doctor_id}|${String(r.off_date).slice(0, 10)}`));
  const busy = {};
  booked.forEach((b) => { const k = `${b.doctor_id}|${b.appointment_date}`; (busy[k] = busy[k] || []).push([T(b.appointment_time), T(b.appointment_time) + Number(b.len)]); });
  return { doctors: doctors.map((d) => ({ ...d, wh: parseWh(d.working_hours) })), off, busy };
}

/**
 * Preview rows.
 * @param {object[]} occurrences  from ical.expand
 * @param {{ from, to, doctorMode:'one'|'keyword', doctorId, keywords:{[doctorId]:string}, fallbackDoctorId }} o
 */
async function plan(ctx, occurrences, o) {
  const { date: today, minutes: nowMinutes } = scheduling.clinicNow(ctx.timezone);
  const cx = await loadContext(ctx, o.from, o.to);
  const docs = ctx.ownDoctorId ? cx.doctors.filter((d) => d.id === ctx.ownDoctorId) : cx.doctors;
  const docById = new Map(docs.map((d) => [d.id, d]));
  const kw = docs.map((d) => ({ id: d.id, words: keywordsOf(o.keywords && o.keywords[d.id] !== undefined ? o.keywords[d.id] : [d.full_name, d.full_name_en].filter(Boolean).join(',')) }));

  const list = occurrences.slice(0, MAX_ROWS);
  const keys = [...new Set(list.map((e) => storedUid(e.key)))];
  const existing = new Set();
  for (let i = 0; i < keys.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    (await knex('appointments').where({ business_id: ctx.businessId }).whereIn('external_uid', keys.slice(i, i + 200)).pluck('external_uid')).forEach((k) => existing.add(k));
  }
  const patients = await knex('patients').where({ business_id: ctx.businessId }).select('id', 'full_name', 'phone');
  const byPhone = new Map(); const byName = new Map();
  patients.forEach((p) => {
    const k = phoneKey(p.phone); if (k.length >= 7) byPhone.set(k, byPhone.has(k) ? null : p);
    const n = String(p.full_name || '').trim().toLowerCase(); if (n) byName.set(n, byName.has(n) ? null : p);
  });

  const seen = new Set(); const planned = {};
  const rows = list.map((e, i) => {
    const text = [e.summary, e.description, e.location].join('\n');
    const phones = extractPhones(text);
    const name = nameFromTitle(e.summary, phones) || String(e.summary || '').slice(0, 190);
    let patient = null; let match = null;
    for (const ph of phones) { const hit = byPhone.get(phoneKey(ph.phone)); if (hit) { patient = hit; match = 'phone'; break; } }
    if (!patient && name) { const hit = byName.get(name.toLowerCase()); if (hit) { patient = hit; match = 'name'; } }
    let doctorId = null;
    if (o.doctorMode === 'keyword') {
      const low = text.toLowerCase();
      const hit = kw.find((d) => d.words.some((w) => low.includes(w)));
      doctorId = hit ? hit.id : (docById.has(Number(o.fallbackDoctorId)) ? Number(o.fallbackDoctorId) : null);
    } else doctorId = docById.has(Number(o.doctorId)) ? Number(o.doctorId) : null;
    const doctor = doctorId ? docById.get(doctorId) : null;
    const minutes = clampMinutes(e.minutes) || (doctor && doctor.slot_duration_minutes) || 30;
    const key = storedUid(e.key);
    let state = null;
    if (e.cancelled) state = 'cancelled';
    else if (e.unsupported) state = 'recurring_unsupported';
    else if (e.allDay) state = 'all_day';
    else if (existing.has(key)) state = 'duplicate';
    else if (seen.has(key)) state = 'duplicate';
    else if (!doctor) state = 'no_doctor';
    else {
      const busyKey = `${doctor.id}|${e.date}`;
      state = checkSlot({ date: e.date, time: e.time, minutes }, { workingHours: doctor.wh, dayOff: cx.off.has(busyKey), busy: (cx.busy[busyKey] || []).concat(planned[busyKey] || []), today, nowMinutes }) || 'ok';
      if (state === 'conflict' && (planned[busyKey] || []).some(([s, en]) => scheduling.overlaps(T(e.time), T(e.time) + minutes, s, en))
        && !(cx.busy[busyKey] || []).some(([s, en]) => scheduling.overlaps(T(e.time), T(e.time) + minutes, s, en))) state = 'conflict_file';
      if (state === 'ok' || state === 'outside_hours') (planned[busyKey] = planned[busyKey] || []).push([T(e.time), T(e.time) + minutes]);
    }
    seen.add(key);
    const selectable = ['ok', 'outside_hours', 'no_doctor'].includes(state);
    const notes = [e.summary && e.summary !== name ? e.summary : '', e.description, e.location].filter(Boolean).join('\n').slice(0, 1000);
    return {
      i, key, date: e.date, time: e.time, minutes: e.allDay ? null : minutes, title: e.summary || '', notes, desc: [e.description, e.location].filter(Boolean).join(' · ').slice(0, 300), name: name || e.summary || '',
      phone: phones.length ? phones[0].phone.slice(0, 40) : '', patientId: patient ? patient.id : null, patientName: patient ? patient.full_name : null, match,
      doctorId, state, selectable, selected: state === 'ok', recurring: e.recurring,
    };
  });
  const counts = rows.reduce((m, r) => { m[r.state] = (m[r.state] || 0) + 1; return m; }, {});
  return { rows, counts, truncated: occurrences.length > MAX_ROWS, total: occurrences.length, doctors: docs };
}

// ---------------------------------------------------------------- import
/**
 * Imports the chosen rows. `rows`: [{ key, date, time, minutes, name, phone, patientId, notes, doctorId }].
 * @returns {{ imported:number, ids:number[], skipped:[{ row, reason }] }}
 */
async function commit(ctx, rows, { allowOutsideHours = false, sourceKind = 'file' } = {}) {
  const { date: today, minutes: nowMinutes } = scheduling.clinicNow(ctx.timezone);
  const result = { imported: 0, ids: [], skipped: [] };
  await knex.transaction(async (outer) => {
    const doctors = await outer('doctors').where({ business_id: ctx.businessId, is_active: true }).select('id', 'working_hours', 'slot_duration_minutes');
    const docById = new Map(doctors.map((d) => [d.id, { ...d, wh: parseWh(d.working_hours) }]));
    for (const r of rows) {
      const skip = (reason) => { result.skipped.push({ row: r, reason }); };
      const doctor = docById.get(Number(r.doctorId));
      if (!doctor || (ctx.ownDoctorId && doctor.id !== ctx.ownDoctorId)) { skip('no_doctor'); continue; } // eslint-disable-line no-continue
      if (!scheduling.isDate(r.date) || !scheduling.isTime(r.time)) { skip('invalid'); continue; } // eslint-disable-line no-continue
      const minutes = clampMinutes(Number(r.minutes)) || doctor.slot_duration_minutes || 30;
      const uid = storedUid(r.key);
      const lock = `appt_${ctx.businessId}_${doctor.id}_${r.date}_${r.time}`.slice(0, 64);
      try {
        // eslint-disable-next-line no-await-in-loop
        const id = await outer.transaction(async (trx) => {
          const [[{ got }]] = await trx.raw('SELECT GET_LOCK(?, 10) AS got', [lock]);
          if (Number(got) !== 1) throw fail('SLOT_BUSY', 'busy', 409);
          try {
            if (await trx('appointments').where({ business_id: ctx.businessId, external_uid: uid }).first('id')) throw fail('duplicate', 'duplicate', 409);
            const [off, booked] = await Promise.all([
              trx('doctor_days_off').where({ business_id: ctx.businessId, doctor_id: doctor.id, off_date: r.date }).first('id'),
              trx('appointments as a').leftJoin('services as s', 's.id', 'a.service_id').where({ 'a.business_id': ctx.businessId, 'a.doctor_id': doctor.id, 'a.appointment_date': r.date })
                .whereNot('a.status', 'cancelled').select('a.appointment_time', trx.raw('COALESCE(a.duration_minutes, s.duration_minutes, ?) as len', [doctor.slot_duration_minutes || 30])),
            ]);
            const problem = checkSlot({ date: r.date, time: r.time, minutes }, { workingHours: doctor.wh, dayOff: Boolean(off), busy: booked.map((b) => [T(b.appointment_time), T(b.appointment_time) + Number(b.len)]), today, nowMinutes });
            if (problem && !(problem === 'outside_hours' && allowOutsideHours)) throw fail(problem, problem, 409);
            const name = String(r.name || '').trim().slice(0, 190) || '—';
            const phone = String(r.phone || '').trim().slice(0, 40) || null;
            let patientId = null;
            if (Number(r.patientId)) { const p = await trx('patients').where({ id: Number(r.patientId), business_id: ctx.businessId }).first('id'); patientId = p ? p.id : null; }
            if (!patientId && phone) patientId = await appts.resolveOrCreatePatient(ctx, { name, phone }, trx);
            const [newId] = await trx('appointments').insert({
              business_id: ctx.businessId, doctor_id: doctor.id, service_id: null, patient_id: patientId, patient_name: name, patient_phone: phone,
              appointment_date: r.date, appointment_time: r.time, duration_minutes: minutes, status: 'confirmed', appointment_type: 'in_person',
              source: 'import', booking_channel: 'staff', amount_due: await appts.expectedFee(trx, ctx.businessId, doctor.id, null),
              notes: String(r.notes || '').slice(0, 3000) || null, created_by: ctx.userId || null, external_source: sourceKind === 'url' ? 'ical_url' : 'ical_file', external_uid: uid,
            });
            await audit.record(ctx, 'appointment.created', { entityType: 'appointment', entityId: newId, newValues: { date: r.date, time: r.time, doctor_id: doctor.id, source: 'import' } }, trx);
            return newId;
          } finally {
            await trx.raw('SELECT RELEASE_LOCK(?)', [lock]);
          }
        });
        result.imported += 1; result.ids.push(id);
      } catch (e) {
        if (e instanceof AppError && e.status === 409) skip(e.code === 'SLOT_BUSY' ? 'conflict' : e.code);
        else if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) skip('duplicate');
        else throw e;
      }
    }
    await audit.record(ctx, 'appointments.imported', { entityType: 'appointment', entityId: null,
      newValues: { source: sourceKind, imported: result.imported, skipped: result.skipped.length, allow_outside_hours: Boolean(allowOutsideHours) } }, outer);
  });
  return result;
}

module.exports = { readSource, fetchCalendar, extractPhones, nameFromTitle, phoneKey, checkSlot, plan, commit, storedUid, MAX_BYTES, MAX_ROWS, ical };
