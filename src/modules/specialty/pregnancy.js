// Pregnancy dating and the antenatal schedule.
//  • Naegele's rule: EDD = LMP + 280 days. From a dating scan: pregnancy "day 0" = scan date − gestational age at the scan.
//  • Gestational age is always shown as weeks+days (e.g. 24+3).
//  • The schedule is a GENERAL GUIDE (the clinic edits its own template): each item has a window in completed weeks.

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (d) => ISO.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const TERM_DAYS = 280;

/** EDD by Naegele's rule. */
const eddFromLmp = (lmp) => addDays(lmp, TERM_DAYS);
/** EDD from a dating scan (scan date + gestational age at the scan in days). */
const eddFromScan = (scanDate, gaDays) => addDays(scanDate, TERM_DAYS - Number(gaDays));
/** Gestational age in days on a date for a pregnancy with this EDD. */
const gaDaysOn = (edd, date) => TERM_DAYS - daysBetween(date, edd);
/** "24+3" */
function gaLabel(days) {
  if (days === null || days === undefined || Number.isNaN(Number(days))) return '—';
  const d = Number(days);
  if (d < 0) return '0+0';
  return `${Math.floor(d / 7)}+${d % 7}`;
}
/** Parses "12+3", "12 3", "12w3d" or "12" into days (0–300), or null. */
function parseGa(weeks, days) {
  let w; let d;
  if (days === undefined || days === null || days === '') {
    const m = String(weeks || '').trim().match(/^(\d{1,2})(?:\s*(?:\+|w|\s)\s*(\d))?\s*d?$/i);
    if (!m) return null;
    w = Number(m[1]); d = Number(m[2] || 0);
  } else { w = Number(weeks); d = Number(days); }
  if (!Number.isInteger(w) || !Number.isInteger(d) || w < 0 || w > 43 || d < 0 || d > 6) return null;
  return w * 7 + d;
}

/**
 * Built-in schedule (a general guide based on common antenatal-care recommendations; each clinic can edit its copy).
 * from/to are completed weeks; rhNeg = only when the mother is Rh-negative.
 */
const DEFAULT_SCHEDULE = [
  { key: 'booking_bloods', from: 6, to: 12 },
  { key: 'dating_scan', from: 11, to: 14 },
  { key: 'anomaly_scan', from: 18, to: 22 },
  { key: 'gtt', from: 24, to: 28 },
  { key: 'bloods_28', from: 28, to: 29 },
  { key: 'anti_d', from: 28, to: 30, rhNeg: true },
  { key: 'tdap', from: 27, to: 36 },
  { key: 'growth_scan', from: 32, to: 36 },
  { key: 'gbs_swab', from: 36, to: 38 },
  { key: 'presentation', from: 36, to: 37 },
  { key: 'post_dates', from: 41, to: 42 },
];

function normaliseSchedule(raw) {
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { list = null; } }
  if (!Array.isArray(list) || !list.length) return DEFAULT_SCHEDULE.map((i) => ({ ...i, label: '' }));
  return list.filter((i) => i && i.key).map((i) => ({ key: String(i.key).slice(0, 40), label: String(i.label || '').slice(0, 120), from: Number(i.from) || 0, to: Number(i.to) || 0, rhNeg: Boolean(i.rhNeg) }));
}

/**
 * Status of each schedule item for a pregnancy on a date: done | overdue | due | upcoming | na (Rh item for Rh-positive).
 * An item is due once GA reaches its first week and overdue after its last week (+6 days).
 */
function scheduleStatus(schedule, { edd, rh, today, done = {} }) {
  const ga = gaDaysOn(edd, today);
  return schedule.map((i) => {
    const dueFrom = addDays(edd, i.from * 7 - TERM_DAYS);
    const dueTo = addDays(edd, i.to * 7 + 6 - TERM_DAYS);
    let status;
    if (done[i.key]) status = 'done';
    else if (i.rhNeg && rh !== 'neg') status = 'na';
    else if (ga > i.to * 7 + 6) status = 'overdue';
    else if (ga >= i.from * 7) status = 'due';
    else status = 'upcoming';
    return { ...i, dueFrom, dueTo, status, doneOn: done[i.key] || null };
  });
}

const RISK_FLAGS = ['previous_caesarean', 'hypertension', 'diabetes', 'previous_gdm', 'previous_preeclampsia', 'multiple', 'age_over_35', 'previous_preterm', 'recurrent_miscarriage', 'anaemia', 'thyroid', 'placenta_praevia', 'ivf'];
const OUTCOMES = ['live_birth', 'stillbirth', 'miscarriage', 'ectopic', 'termination', 'other'];
const DELIVERY_MODES = ['vaginal', 'assisted', 'caesarean'];
const PRESENTATIONS = ['cephalic', 'breech', 'transverse', 'unknown'];
const OEDEMA = ['none', 'mild', 'moderate', 'severe'];
const URINE = ['neg', 'trace', '1+', '2+', '3+'];
const BLOOD_GROUPS = ['A', 'B', 'AB', 'O'];

module.exports = {
  TERM_DAYS, isIso, addDays, daysBetween, eddFromLmp, eddFromScan, gaDaysOn, gaLabel, parseGa, DEFAULT_SCHEDULE, normaliseSchedule, scheduleStatus,
  RISK_FLAGS, OUTCOMES, DELIVERY_MODES, PRESENTATIONS, OEDEMA, URINE, BLOOD_GROUPS,
};
