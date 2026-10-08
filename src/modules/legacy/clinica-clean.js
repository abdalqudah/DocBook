// Cleaning of the Clinica backup, shared by the import (promote.service) and scripts/clinica-clean.js:
//   • a treatment's description as scraped from Clinica's page ("Examination    more...X  Chief Complaint  pain
//     View Notes") → its name ("Examination") and its details ([["Chief Complaint", "pain"]]);
//   • "Clinic One" … "Clinic Five" written where the doctor goes: a chair of the clinic, not a doctor — the doctor of
//     such a treatment is the patient's doctor of that day, else the patient's usual doctor, else the doctor seen most
//     with that clinic number;
//   • a doctor's name in English (Clinica) ↔ in Arabic (here): compared by a consonant skeleton ("Faris Qudah" and
//     "د. فارس القضاة" both give "frs kd");
//   • clinical tables that hold no patient data: Clinica's empty forms (periodontal chart, pocket measurements…),
//     copies of the treatments table, and "No … records found." rows.
const norm = (s) => String(s === null || s === undefined ? '' : s).replace(/ /g, ' ');
const squash = (s) => norm(s).replace(/\s+/g, ' ').trim();

// ================================================================= descriptions
/** Clinica's description cell → { name, details: [[label, value]…] }. */
function description(raw) {
  const s = norm(raw);
  const cut = s.search(/\s*more\.\.\./i);
  let head = cut >= 0 ? s.slice(0, cut) : s;
  let rest = cut >= 0 ? s.slice(cut).replace(/^\s*more\.\.\.\s*X?/i, '') : '';
  if (cut < 0) { const v = head.search(/\s*View Notes\s*$/i); if (v >= 0) head = head.slice(0, v); }
  rest = rest.replace(/\s*View Notes\s*$/i, '');
  const details = [];
  // blocks separated by blank lines: the first line is the label, the others its value
  rest.split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length).forEach((b) => {
    if (b.length === 1) details.push([null, b[0]]);
    else details.push([b[0], b.slice(1).join(' ')]);
  });
  return { name: squash(head), details };
}

/** The description's name and its details as note lines ("Chief Complaint: pain"). */
function cleanTreatment(desc) {
  const { name, details } = description(desc);
  return { name, lines: details.map(([l, v]) => (l ? `${l}: ${v}` : v)) };
}

// ================================================================= doctors
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const CHAIR = /^(?:clinic|chair|room|unit|عياد[ةه]|كرسي|غرف[ةه])\s*(?:no\.?|#|رقم)?\s*([a-z]+|\d{1,2}|[٠-٩]{1,2})$/i;
/** "Clinic One" / "Clinic 2" / "عيادة 3" → its number (a chair of the clinic, not a doctor), else null. */
function chairOf(name) {
  const m = CHAIR.exec(squash(name));
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (WORDS[v]) return WORDS[v];
  const n = Number(v.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A doctor's name with spaces tidied ("Raghad  Kafina" → "Raghad Kafina"). */
const doctorName = (name) => squash(name);

const AR = {
  'ب': 'b', 'ت': 't', 'ث': 't', 'ج': 'j', 'ح': 'h', 'خ': 'K', 'د': 'd', 'ذ': 'd', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'S', 'ص': 's', 'ض': 'd',
  'ط': 't', 'ظ': 'z', 'غ': 'G', 'ف': 'f', 'ق': 'k', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'ة': 'h', 'و': 'w', 'ي': 'y', 'ى': '', 'پ': 'b', 'چ': 'j', 'گ': 'j', 'ڤ': 'f',
};
const TITLES = new Set(['dr', 'doctor', 'prof', 'mr', 'mrs', 'ms', 'د', 'دكتور', 'دكتوره', 'دكتورة', 'الدكتور', 'الدكتورة', 'الدكتوره']);
function skelWord(w) {
  let s;
  if (/[؀-ۿ]/.test(w)) {
    const x = w.replace(/^ال(?=..)/, '').replace(/[ً-ٰٟ]/g, '');
    s = [...x].map((c, i) => (c === 'و' || c === 'ي' ? (i === 0 ? AR[c] : '') : (AR[c] !== undefined ? AR[c] : ''))).join('');
  } else {
    const x = w.toLowerCase().replace(/^al-?(?=[a-z]{3})/, '').replace(/[^a-z]/g, '');
    s = x.replace(/sh|ch/g, 'S').replace(/kh/g, 'K').replace(/gh/g, 'G').replace(/th/g, 't').replace(/dh/g, 'd').replace(/ph/g, 'f')
      .replace(/q/g, 'k').replace(/g/g, 'j').replace(/v/g, 'f').replace(/p/g, 'b').replace(/c/g, 'k').replace(/x/g, 'ks')
      .replace(/(?!^)[wy]/g, '').replace(/[aeiou]/g, '');
  }
  return s.replace(/(.)\1+/g, '$1').replace(/(?<=.)h$/, '');
}
/** A name's consonant skeleton per word, titles ("Dr", "د.") and "al"/"ال" left out. */
function skeleton(name) {
  return squash(name).split(/[\s.\-_,]+/).filter((w) => w && !TITLES.has(w.toLowerCase()) && !['al', 'el', 'ال'].includes(w.toLowerCase())).map(skelWord).filter(Boolean);
}
/** Whether two names (any script) are the same person: same first name and, when both have one, the same last name. */
function sameDoctor(a, b) {
  const x = skeleton(a); const y = skeleton(b);
  if (!x.length || !y.length || x[0] !== y[0]) return false;
  return x.length < 2 || y.length < 2 || x[x.length - 1] === y[y.length - 1];
}
/** The one doctor of `doctors` ([{ id, names: [...] }]) that `name` is, or null (none or more than one). */
function matchDoctor(name, doctors) {
  const hits = doctors.filter((d) => d.names.some((n) => n && sameDoctor(name, n)));
  const ids = [...new Set(hits.map((d) => d.id))];
  return ids.length === 1 ? ids[0] : null;
}

/**
 * The doctor of treatments whose name is not a doctor (a chair, or none): for each such treatment (needs(t) true), the
 * patient's doctor of that day, else the patient's most frequent doctor, else fallback(t). doctorOf(t) is the doctor of
 * a treatment that has one. Returns a Map treatment → doctor (only for the treatments that needed one and got one).
 */
function inferDoctors(treatments, { needs, doctorOf, dayOf, fallback = () => null }) {
  const known = treatments.filter((t) => !needs(t) && doctorOf(t) !== null && doctorOf(t) !== undefined && doctorOf(t) !== '');
  const top = (list) => {
    const c = new Map();
    list.forEach((t) => c.set(doctorOf(t), (c.get(doctorOf(t)) || 0) + 1));
    let best = null; let n = 0;
    c.forEach((v, k) => { if (v > n) { best = k; n = v; } });
    return best;
  };
  const usual = top(known);
  const out = new Map();
  treatments.filter(needs).forEach((t) => {
    const d = top(known.filter((k) => dayOf(k) && dayOf(k) === dayOf(t))) || usual || fallback(t);
    if (d !== null && d !== undefined && d !== '') out.set(t, d);
  });
  return out;
}

// ================================================================= clinical tables
const FORM = new Set([
  'factor', 'normal', 'abnormal', 'plaque', 'good', 'poor', 'gingival bleeding (bop)', 'absent', 'present', 'calculus', 'supragingival', 'subgingival',
  'site', 'pd (mm)', 'cal (mm)', 'mobility', 'furcation', 'upper right quadrant', 'upper left quadrant', 'lower left quadrant', 'lower right quadrant',
  '1–3', '4–5', '≥6', '0–2', '3–4', '≥5', '0', 'i', 'ii', 'iii', 'n/a', 'pocket distribution', 'localized', 'generalized', 'deepest site', 'tooth #',
  'site / mm', 'furcation involvement', 'location', 'diagnosis', 'healthy', 'gingivitis', 'mild periodontitis', 'moderate periodontitis',
  'severe periodontitis', 'treatment notes', '-', 'file name', 'description', 'upload date', 'delete', 'entry date', 'type of anesthesia',
  'use of epinephrine', 'number of carpules used', 'injection site', 'complications / reactions', 'author',
]);
const cellWords = (c) => norm(c).split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
const EMPTY_ROW = /^no .* (records?|data) found\.?$/i;
const COPY_HEAD = (r) => Array.isArray(r) && /^select\s*\/\s*print$/i.test(squash(r[0])) && r.some((c) => /^tooth$/i.test(squash(c))) && r.some((c) => /^description$/i.test(squash(c)));

/**
 * A clinical table (list of rows, the first its header) without what carries no patient data: "No … found." rows,
 * copies of the treatments table, and Clinica's empty forms. Returns the rows to keep ([] = nothing to keep).
 */
function clinicalRows(value) {
  if (!Array.isArray(value) || !value.every(Array.isArray)) return value;
  const rows = value.filter((r) => !(r.length === 1 && EMPTY_ROW.test(squash(r[0]))));
  if (rows.some(COPY_HEAD)) return [];
  if (rows.every((r) => r.every((c) => cellWords(c).every((w) => FORM.has(w))))) return [];
  return rows;
}

module.exports = { description, cleanTreatment, chairOf, doctorName, skeleton, sameDoctor, matchDoctor, inferDoctors, clinicalRows };
