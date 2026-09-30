// Small iCalendar (RFC 5545) reader for importing appointments — no dependency.
// Supports: line unfolding, escaped text (\n \, \; \\), quoted parameters, VEVENT with DTSTART/DTEND/DURATION in UTC
// ('Z'), with TZID (IANA names, common Windows names, or a fixed offset read from the file's VTIMEZONE), floating
// times (read in the clinic's zone) and all-day dates (VALUE=DATE), SUMMARY, DESCRIPTION, LOCATION, UID, STATUS.
// Recurrence: FREQ=DAILY and FREQ=WEEKLY (INTERVAL, COUNT, UNTIL, BYDAY) are expanded inside the chosen range, with
// EXDATE and RECURRENCE-ID overrides. Other rules (monthly, yearly, BYSETPOS…) are listed but not imported
// (reason 'recurring_unsupported') — the clinic sees them in the preview instead of getting a wrong schedule.

const DAY = 86_400_000;
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_OCCURRENCES = 1000; // per recurring event, safety bound

// Windows time-zone names Outlook writes as TZID (the ones clinics in the region use, plus a few common ones).
const WINDOWS_TZ = {
  'jordan standard time': 'Asia/Amman', 'arab standard time': 'Asia/Riyadh', 'arabic standard time': 'Asia/Baghdad', 'arabian standard time': 'Asia/Dubai',
  'egypt standard time': 'Africa/Cairo', 'syria standard time': 'Asia/Damascus', 'middle east standard time': 'Asia/Beirut', 'west bank standard time': 'Asia/Hebron',
  'israel standard time': 'Asia/Jerusalem', 'turkey standard time': 'Europe/Istanbul', 'iran standard time': 'Asia/Tehran', 'libya standard time': 'Africa/Tripoli',
  'morocco standard time': 'Africa/Casablanca', 'e. africa standard time': 'Africa/Nairobi', 'south africa standard time': 'Africa/Johannesburg',
  'gmt standard time': 'Europe/London', 'greenwich standard time': 'Atlantic/Reykjavik', 'w. europe standard time': 'Europe/Berlin', 'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest', 'e. europe standard time': 'Europe/Chisinau', 'gtb standard time': 'Europe/Bucharest', 'russian standard time': 'Europe/Moscow',
  'eastern standard time': 'America/New_York', 'central standard time': 'America/Chicago', 'mountain standard time': 'America/Denver', 'pacific standard time': 'America/Los_Angeles',
  'india standard time': 'Asia/Kolkata', 'pakistan standard time': 'Asia/Karachi', 'china standard time': 'Asia/Shanghai', 'tokyo standard time': 'Asia/Tokyo',
  'aus eastern standard time': 'Australia/Sydney', utc: 'UTC', 'coordinated universal time': 'UTC',
};

// ---------------------------------------------------------------- lines
function unfold(text) {
  return String(text || '').replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.trim() !== '');
}

function unescapeText(v) {
  return String(v || '').replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** "DTSTART;TZID=\"Asia/Amman\":20261001T090000" → { name, params:{TZID}, value } */
function parseLine(line) {
  let inQ = false; let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon); const value = line.slice(colon + 1);
  const parts = []; let cur = ''; inQ = false;
  for (const c of head) {
    if (c === '"') { inQ = !inQ; continue; } // eslint-disable-line no-continue
    if (c === ';' && !inQ) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const params = {};
  parts.slice(1).forEach((p) => { const eq = p.indexOf('='); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1); });
  return { name: parts[0].toUpperCase(), params, value };
}

// ---------------------------------------------------------------- time zones
const fmtCache = new Map();
function tzFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
  }
  return fmtCache.get(tz);
}
function validZone(tz) { try { tzFormatter(tz); return true; } catch { return false; } }

/** Wall-clock parts of a UTC instant in a zone ({ fixed: minutes } = constant offset). */
function wallOf(ms, zone) {
  if (zone && typeof zone === 'object') { const d = new Date(ms + zone.fixed * 60000); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }; }
  const p = Object.fromEntries(tzFormatter(zone || 'UTC').formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: p.hour === '24' ? 0 : Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}
function offsetMin(zone, ms) {
  const w = wallOf(ms, zone);
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000) / 60000);
}
/** Wall-clock time in a zone → UTC ms (DST gaps resolve forward, overlaps to the first occurrence). */
function wallToUtc(w, zone) {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h || 0, w.mi || 0, w.s || 0);
  if (zone && typeof zone === 'object') return guess - zone.fixed * 60000;
  const o1 = offsetMin(zone, guess);
  let t = guess - o1 * 60000;
  const o2 = offsetMin(zone, t);
  if (o2 !== o1) t = guess - o2 * 60000;
  return t;
}

/** TZID → IANA zone / fixed offset / null (unknown → caller uses the clinic's zone). */
function resolveZone(tzid, vtimezones) {
  if (!tzid) return null;
  const raw = String(tzid).replace(/^\//, '').trim();
  if (validZone(raw)) return raw;
  const tail = raw.match(/([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/); // "/mozilla.org/20050126_1/Asia/Amman"
  if (tail && validZone(tail[1])) return tail[1];
  const win = WINDOWS_TZ[raw.toLowerCase()];
  if (win) return win;
  const vt = vtimezones && vtimezones[raw];
  if (vt && vt.offset !== null && vt.offset !== undefined) return { fixed: vt.offset };
  return null;
}

// ---------------------------------------------------------------- values
/** "20261001T090000Z" / "20261001T090000" / "20261001" → { y, mo, d, h, mi, s, utc, date } */
function parseDateValue(v) {
  const m = String(v || '').trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i);
  if (!m) return null;
  const out = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4] || 0), mi: Number(m[5] || 0), s: Number(m[6] || 0), utc: Boolean(m[7]), date: !m[4] };
  if (out.mo < 1 || out.mo > 12 || out.d < 1 || out.d > 31 || out.h > 23 || out.mi > 59) return null;
  return out;
}

/** "PT1H30M" / "P1D" / "-PT15M" → minutes */
function parseDuration(v) {
  const m = String(v || '').trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return null;
  const mins = (Number(m[2] || 0) * 7 * 1440) + (Number(m[3] || 0) * 1440) + (Number(m[4] || 0) * 60) + Number(m[5] || 0) + Math.floor(Number(m[6] || 0) / 60);
  return m[1] === '-' ? -mins : mins;
}

function parseRrule(v) {
  const r = {};
  String(v || '').split(';').forEach((p) => { const [k, val] = p.split('='); if (k && val !== undefined) r[k.toUpperCase()] = val; });
  return r;
}

// ---------------------------------------------------------------- parse
/**
 * @returns {{ name: string|null, timezone: string|null, events: object[] }}
 * Each raw event: { uid, summary, description, location, status, start, end, duration, rrule, exdates, recurrenceId, tzid }
 */
function parse(text) {
  const lines = unfold(text);
  const events = []; const vtimezones = {};
  let calName = null; let calTz = null;
  const stack = []; let ev = null; let vt = null; let vtSub = null;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue; // eslint-disable-line no-continue
    if (p.name === 'BEGIN') {
      const comp = p.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT') ev = { exdates: [], params: {} };
      else if (comp === 'VTIMEZONE') vt = { id: null, offset: null };
      else if ((comp === 'STANDARD' || comp === 'DAYLIGHT') && vt) vtSub = comp;
      continue; // eslint-disable-line no-continue
    }
    if (p.name === 'END') {
      const comp = p.value.trim().toUpperCase();
      // tolerate unbalanced files: pop up to the matching BEGIN
      const at = stack.lastIndexOf(comp);
      if (at >= 0) stack.length = at;
      if (comp === 'VEVENT' && ev) { events.push(ev); ev = null; }
      if (comp === 'VTIMEZONE' && vt) { if (vt.id) vtimezones[vt.id] = vt; vt = null; }
      if (comp === 'STANDARD' || comp === 'DAYLIGHT') vtSub = null;
      continue; // eslint-disable-line no-continue
    }
    const top = stack[stack.length - 1];
    if (top === 'VCALENDAR') {
      if (p.name === 'X-WR-CALNAME') calName = unescapeText(p.value).trim() || null;
      if (p.name === 'X-WR-TIMEZONE') calTz = p.value.trim() || null;
    } else if (top === 'VTIMEZONE' && vt && p.name === 'TZID') vt.id = p.value.trim();
    else if ((top === 'STANDARD' || top === 'DAYLIGHT') && vt && p.name === 'TZOFFSETTO') {
      const m = p.value.trim().match(/^([+-])(\d{2})(\d{2})/);
      if (m && (vtSub === 'STANDARD' || vt.offset === null)) vt.offset = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    } else if (top === 'VEVENT' && ev) {
      switch (p.name) {
        case 'UID': ev.uid = p.value.trim(); break;
        case 'SUMMARY': ev.summary = unescapeText(p.value).trim(); break;
        case 'DESCRIPTION': ev.description = unescapeText(p.value).trim(); break;
        case 'LOCATION': ev.location = unescapeText(p.value).trim(); break;
        case 'STATUS': ev.status = p.value.trim().toUpperCase(); break;
        case 'DTSTART': ev.start = parseDateValue(p.value); ev.startTz = p.params.TZID || null; if (p.params.VALUE === 'DATE' && ev.start) ev.start.date = true; break;
        case 'DTEND': ev.end = parseDateValue(p.value); ev.endTz = p.params.TZID || null; if (p.params.VALUE === 'DATE' && ev.end) ev.end.date = true; break;
        case 'DURATION': ev.duration = parseDuration(p.value); break;
        case 'RRULE': ev.rrule = parseRrule(p.value); break;
        case 'EXDATE': p.value.split(',').forEach((x) => { const d = parseDateValue(x); if (d) ev.exdates.push({ ...d, tz: p.params.TZID || null }); }); break;
        case 'RECURRENCE-ID': ev.recurrenceId = parseDateValue(p.value); ev.recurrenceTz = p.params.TZID || null; break;
        default: break;
      }
    }
  }
  return { name: calName, timezone: calTz, events, vtimezones };
}

// ---------------------------------------------------------------- expand
const pad = (n) => String(n).padStart(2, '0');
const ymd = (w) => `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
const hm = (w) => `${pad(w.h)}:${pad(w.mi)}`;
const addDaysW = (w, n) => { const d = new Date(Date.UTC(w.y, w.mo - 1, w.d) + n * DAY); return { ...w, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const dow = (w) => new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();

/**
 * Occurrences between `from` and `to` (clinic dates, inclusive), converted to the clinic's time zone.
 * @param {object} cal  result of parse()
 * @param {{ from: string, to: string, timezone: string }} o
 * @returns {object[]} { key, uid, summary, description, location, date, time, minutes, allDay, cancelled, recurring, unsupported }
 */
function expand(cal, { from, to, timezone }) {
  const clinicZone = timezone || 'UTC';
  const fallbackZone = resolveZone(cal.timezone, cal.vtimezones) || clinicZone;
  const out = [];
  const overrides = new Map(); // uid|originalStartUtc → event
  cal.events.filter((e) => e.recurrenceId && e.uid).forEach((e) => {
    const z = e.recurrenceId.utc ? 'UTC' : resolveZone(e.recurrenceTz || e.startTz, cal.vtimezones) || fallbackZone;
    const t = e.recurrenceId.date ? Date.UTC(e.recurrenceId.y, e.recurrenceId.mo - 1, e.recurrenceId.d) : wallToUtc(e.recurrenceId, z);
    overrides.set(`${e.uid}|${e.recurrenceId.date ? ymd(e.recurrenceId) : t}`, e);
  });

  const emit = (e, startUtc, minutes, allDay, key, recurring, startWall) => {
    let date; let time = null;
    if (allDay) date = ymd(startWall);
    else { const w = wallOf(startUtc, clinicZone); date = ymd(w); time = hm(w); }
    if (date < from || date > to) return;
    out.push({
      key, uid: e.uid || null, summary: e.summary || '', description: e.description || '', location: e.location || '', date, time,
      minutes: allDay ? null : minutes, allDay, cancelled: e.status === 'CANCELLED', recurring, unsupported: null,
    });
  };

  let anon = 0;
  for (const e of cal.events) {
    if (!e.start || e.recurrenceId) continue; // eslint-disable-line no-continue
    anon += 1;
    const uid = e.uid || `nouid-${anon}-${ymd(e.start)}${pad(e.start.h)}${pad(e.start.mi)}`;
    const allDay = Boolean(e.start.date);
    const zone = e.start.utc ? 'UTC' : resolveZone(e.startTz, cal.vtimezones) || fallbackZone;
    const startUtc = allDay ? Date.UTC(e.start.y, e.start.mo - 1, e.start.d) : wallToUtc(e.start, zone);
    let minutes = null;
    if (!allDay) {
      if (e.end && !e.end.date) {
        const endZone = e.end.utc ? 'UTC' : resolveZone(e.endTz || e.startTz, cal.vtimezones) || zone;
        minutes = Math.round((wallToUtc(e.end, endZone) - startUtc) / 60000);
      } else if (e.duration !== null && e.duration !== undefined) minutes = e.duration;
      if (minutes !== null && minutes <= 0) minutes = null;
    }
    if (!e.rrule) { emit(e, startUtc, minutes, allDay, uid, false, e.start); continue; } // eslint-disable-line no-continue

    const r = e.rrule; const freq = String(r.FREQ || '').toUpperCase();
    const simple = (freq === 'DAILY' || freq === 'WEEKLY') && !r.BYSETPOS && !r.BYMONTH && !r.BYMONTHDAY && !r.BYYEARDAY && !r.BYWEEKNO && !r.BYHOUR && !r.BYMINUTE;
    if (!simple) {
      // listed once (its first date inside the range, if any, else its start) — not imported.
      const w = allDay ? e.start : wallOf(startUtc, clinicZone);
      const date = ymd(w) < from ? from : ymd(w);
      if (date <= to) out.push({ key: uid, uid, summary: e.summary || '', description: e.description || '', location: e.location || '', date, time: allDay ? null : hm(w), minutes, allDay, cancelled: e.status === 'CANCELLED', recurring: true, unsupported: freq.toLowerCase() || 'rule' });
      continue; // eslint-disable-line no-continue
    }
    const interval = Math.max(1, Number(r.INTERVAL) || 1);
    const count = r.COUNT ? Math.max(1, Number(r.COUNT)) : null;
    let untilUtc = null;
    if (r.UNTIL) { const u = parseDateValue(r.UNTIL); if (u) untilUtc = u.date ? Date.UTC(u.y, u.mo - 1, u.d) + DAY - 1 : (u.utc ? Date.UTC(u.y, u.mo - 1, u.d, u.h, u.mi, u.s) : wallToUtc(u, zone)); }
    const byday = freq === 'WEEKLY' ? String(r.BYDAY || WD[dow(e.start)]).split(',').map((x) => WD.indexOf(x.trim().slice(-2).toUpperCase())).filter((x) => x >= 0) : null;
    const exKeys = new Set(e.exdates.map((x) => (x.date ? ymd(x) : String(x.utc ? Date.UTC(x.y, x.mo - 1, x.d, x.h, x.mi, x.s) : wallToUtc(x, resolveZone(x.tz, cal.vtimezones) || zone)))));
    const exDates = new Set(e.exdates.map((x) => ymd(x)));
    // Walk wall-clock dates in the event's own zone (so 09:00 stays 09:00 across DST changes).
    const wkst = WD.indexOf(String(r.WKST || 'MO').toUpperCase());
    const startDow = dow(e.start);
    const weekStart = addDaysW(e.start, -((startDow - (wkst < 0 ? 1 : wkst) + 7) % 7));
    const toLimit = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10))) + 2 * DAY;
    let n = 0; let emitted = 0;
    for (let i = 0; i < 20000 && emitted < MAX_OCCURRENCES; i += 1) {
      let candidates;
      if (freq === 'DAILY') candidates = [addDaysW(e.start, i * interval)];
      else {
        const ws = addDaysW(weekStart, i * 7 * interval);
        candidates = [0, 1, 2, 3, 4, 5, 6].map((k) => addDaysW(ws, k)).filter((w) => byday.includes(dow(w))).filter((w) => ymd(w) >= ymd(e.start));
      }
      let stop = false;
      for (const w of candidates) {
        const occUtc = allDay ? Date.UTC(w.y, w.mo - 1, w.d) : wallToUtc(w, zone);
        if (untilUtc !== null && occUtc > untilUtc) { stop = true; break; }
        n += 1;
        if (count !== null && n > count) { stop = true; break; }
        if (occUtc > toLimit) { stop = true; break; }
        const exKey = allDay ? ymd(w) : String(occUtc);
        if (exKeys.has(exKey) || (allDay && exDates.has(ymd(w)))) continue; // eslint-disable-line no-continue
        const occKey = `${uid}@${ymd(w).replace(/-/g, '')}`;
        const ov = overrides.get(`${e.uid}|${allDay ? ymd(w) : occUtc}`);
        if (ov) {
          if (ov.start) {
            const oz = ov.start.utc ? 'UTC' : resolveZone(ov.startTz, cal.vtimezones) || zone;
            const oStart = ov.start.date ? Date.UTC(ov.start.y, ov.start.mo - 1, ov.start.d) : wallToUtc(ov.start, oz);
            let om = minutes;
            if (ov.end && !ov.end.date) om = Math.round((wallToUtc(ov.end, ov.end.utc ? 'UTC' : resolveZone(ov.endTz || ov.startTz, cal.vtimezones) || oz) - oStart) / 60000);
            else if (ov.duration) om = ov.duration;
            emit({ ...e, ...ov, status: ov.status || e.status, summary: ov.summary || e.summary }, oStart, om > 0 ? om : null, Boolean(ov.start.date), occKey, true, ov.start);
          }
        } else emit(e, occUtc, minutes, allDay, occKey, true, w);
        emitted += 1;
      }
      if (stop) break;
    }
  }
  return out.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

// ---------------------------------------------------------------- write (the doctor's subscription feed)
const escapeText = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Folds a content line at 75 octets (UTF-8 safe). */
function fold(line) {
  const out = []; let cur = ''; let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** @param {{ name, events:[{ uid, startUtc, endUtc, summary, status? }] }} cal */
function build({ name, events, prodId = '-//DocBook//Clinic schedule//EN' }) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodId}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(name)}`, 'X-PUBLISHED-TTL:PT15M', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M'];
  const stamp = utcStamp(Date.now());
  events.forEach((e) => {
    L.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp}`, `DTSTART:${utcStamp(e.startUtc)}`, `DTEND:${utcStamp(e.endUtc)}`, `SUMMARY:${escapeText(e.summary)}`, 'TRANSP:OPAQUE', 'CLASS:PRIVATE');
    if (e.status) L.push(`STATUS:${e.status}`);
    L.push('END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return `${L.map(fold).join('\r\n')}\r\n`;
}

module.exports = { parse, expand, build, unfold, unescapeText, parseLine, parseDateValue, parseDuration, resolveZone, wallToUtc, wallOf };
