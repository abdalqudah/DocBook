// The specialty forms: every form, which specialties each belongs to, and the forms a clinic gets by default from its
// own specialty and its doctors' specialties.
const catalogue = require('../catalogue');

const FORMS = [
  ...require('./defs-eye-ent'),
  ...require('./defs-cardio-medicine'),
  ...require('./defs-neuro-psych'),
  ...require('./defs-msk-skin'),
  ...require('./defs-women-uro'),
  ...require('./defs-surgery-other'),
];
const BY_KEY = new Map(FORMS.map((f) => [f.key, f]));
const KEYS = FORMS.map((f) => f.key);

// The three record screens of their own (dental chart, child growth, pregnancy) and the specialties they serve.
const MODULE_SPECIALTIES = { dental: ['dentistry'], growth: ['paediatrics'], pregnancy: ['obgyn'] };

const get = (key) => BY_KEY.get(key) || null;

/** Forms of one specialty: those declared for it; a specialty with none of its own gets its broader one's. */
function forSpecialty(key) {
  for (const s of catalogue.lineage(key)) {
    const own = FORMS.filter((f) => f.specialties.includes(s)).map((f) => f.key);
    if (own.length) return own;
  }
  return [];
}

/** Does a record screen of its own (dental | growth | pregnancy) belong to the specialty? */
const moduleFor = (module, key) => Boolean(key) && catalogue.lineage(key).some((s) => MODULE_SPECIALTIES[module].includes(s));

/**
 * Forms switched on without the clinic choosing: those of the clinic's specialty and of every active doctor's
 * specialty. A broad clinic (general / multi / other) with no doctor specialty yet gets the general-practice set.
 */
function defaults(clinicSpecialty, doctorSpecialties = []) {
  const keys = new Set();
  const specs = [clinicSpecialty, ...doctorSpecialties].filter((s) => s && catalogue.has(s));
  for (const s of specs) {
    if (catalogue.BROAD.has(s)) continue; // eslint-disable-line no-continue
    forSpecialty(s).forEach((k) => keys.add(k));
  }
  if (!keys.size) forSpecialty('general').forEach((k) => keys.add(k));
  return KEYS.filter((k) => keys.has(k));
}

/** The specialties a form is listed under in the settings (first one = its home). */
const homeOf = (form) => form.specialties[0];

module.exports = { FORMS, KEYS, MODULE_SPECIALTIES, get, forSpecialty, moduleFor, defaults, homeOf };
