// Child growth against the WHO Child Growth Standards (0–5 years), with the LMS method.
// Reference data: ./who-lms.json (official WHO daily LMS tables, see its _source/_provenance notes). Nothing here is
// approximated: when a child is outside 0–1856 days, or a value is missing, no z-score is given.
const WHO = require('./who-lms.json');

const MAX_DAY = 1856; // 5 years (WHO tables end here)
const INDICATORS = ['wfa', 'lhfa', 'hcfa', 'bfa'];
// Percentile curves drawn on the charts (WHO's usual set).
const CURVES = [{ p: 3, z: -1.880794 }, { p: 15, z: -1.036433 }, { p: 50, z: 0 }, { p: 85, z: 1.036433 }, { p: 97, z: 1.880794 }];

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const sexKey = (gender) => (gender === 'male' ? 'male' : gender === 'female' ? 'female' : null);

function lms(indicator, sex, ageDays) {
  const table = WHO[indicator] && WHO[indicator][sex];
  if (!table || !Number.isInteger(ageDays) || ageDays < 0 || ageDays > MAX_DAY) return null;
  const [L, M, S] = table[ageDays];
  return { L, M, S };
}

/** Value at a given z-score: M(1+LSz)^(1/L). */
function valueAt({ L, M, S }, z) {
  return L === 0 ? M * Math.exp(S * z) : M * (1 + L * S * z) ** (1 / L);
}

/**
 * z-score by the LMS method. For weight and BMI (skewed), WHO restricts the LMS curve beyond ±3 SD and extends it
 * linearly using the distance between the 2nd and 3rd SD (WHO Child Growth Standards, methods and development, 2006).
 */
function zScore(indicator, value, p) {
  const y = Number(value);
  if (!p || !(y > 0)) return null;
  const { L, M, S } = p;
  let z = L === 0 ? Math.log(y / M) / S : ((y / M) ** L - 1) / (L * S);
  if ((indicator === 'wfa' || indicator === 'bfa') && Math.abs(z) > 3) {
    if (z > 3) {
      const sd3 = valueAt(p, 3); const sd23 = sd3 - valueAt(p, 2);
      z = 3 + (y - sd3) / sd23;
    } else {
      const sd3 = valueAt(p, -3); const sd23 = valueAt(p, -2) - sd3;
      z = -3 + (y - sd3) / sd23;
    }
  }
  return z;
}

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, absolute error < 7.5e-8 — ample for a percentile). */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
const percentile = (z) => (z === null || z === undefined ? null : normCdf(z) * 100);

/**
 * Length/height as WHO expects it: recumbent length before 731 days, standing height from 731 days.
 * A standing measure under 2 years gets +0.7 cm, a lying one from 2 years −0.7 cm (WHO convention).
 */
function adjustedLength(cm, ageDays, position) {
  const v = Number(cm);
  if (!(v > 0)) return null;
  if (ageDays < 731 && position === 'standing') return v + 0.7;
  if (ageDays >= 731 && position === 'lying') return v - 0.7;
  return v;
}

const bmi = (kg, cm) => (Number(kg) > 0 && Number(cm) > 0 ? Number(kg) / ((Number(cm) / 100) ** 2) : null);

/** All four indicators for one measurement: { ageDays, wfa: { value, z, p }, lhfa, hcfa, bfa }. */
function assess({ dob, gender, date, weightKg, lengthCm, headCm, position }) {
  const sex = sexKey(gender);
  const ageDays = dob && date ? daysBetween(dob, date) : null;
  const out = { ageDays, sex, inRange: sex !== null && ageDays !== null && ageDays >= 0 && ageDays <= MAX_DAY };
  const len = ageDays !== null ? adjustedLength(lengthCm, ageDays, position) : null;
  const values = { wfa: Number(weightKg) > 0 ? Number(weightKg) : null, lhfa: len, hcfa: Number(headCm) > 0 ? Number(headCm) : null, bfa: bmi(weightKg, len) };
  INDICATORS.forEach((k) => {
    const v = values[k];
    const z = out.inRange && v ? zScore(k, v, lms(k, sex, ageDays)) : null;
    out[k] = { value: v, z, p: percentile(z) };
  });
  return out;
}

/** Percentile curves for a chart, sampled every `step` days from 0 to `toDay`. */
function curves(indicator, sex, toDay, step = 7) {
  const end = Math.min(MAX_DAY, toDay);
  return CURVES.map((c) => {
    const pts = [];
    for (let d = 0; d <= end; d += step) pts.push([d, valueAt(lms(indicator, sex, d), c.z)]);
    if (pts[pts.length - 1][0] !== end) pts.push([end, valueAt(lms(indicator, sex, end), c.z)]);
    return { p: c.p, pts };
  });
}

module.exports = { WHO_SOURCE: WHO._source, MAX_DAY, INDICATORS, CURVES, lms, valueAt, zScore, normCdf, percentile, adjustedLength, bmi, assess, curves, daysBetween, sexKey };
