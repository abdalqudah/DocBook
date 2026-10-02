// The ready diagnosis table of a clinic: the ICD-10 codes of the bundled WHO list that belong to the clinic's
// specialty (chosen at sign-up / in the clinic's settings). Shown in the clinic's settings, and offered first in the
// doctor's diagnosis search. General, multi-specialty and other clinics get the common primary-care diagnoses.
// Ranges are ICD-10 code prefixes ("K0" = K00–K09, "K12" = K12.x, "S02.5" = that code only).
const range = (letter, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${letter}${String(from + i).padStart(2, '0')}`);

const PREFIXES = {
  dentistry: [...range('K', 0, 14), 'S02.5', 'M26', 'B37.0', 'R68.2'],
  dermatology: ['L', 'B00', 'B01', 'B02', 'B07', 'B08', 'B35', 'B36', 'B86', 'D22', 'D23', 'Q82'],
  paediatrics: ['P', ...range('J', 0, 6), 'J20', 'J21', 'J45', 'A08', 'A09', 'H66', 'R50', 'R62', 'E66', 'L22', 'L20', 'B01', 'B05', 'B26', 'B08', 'K59.0', 'R10', 'Z00.1', 'Z23'],
  obgyn: ['O', ...range('N', 70, 98), ...range('Z', 30, 39), 'D25', 'E28.2'],
  orthopaedics: ['M', 'S', 'G56.0', 'Q65', 'Q66'],
  ophthalmology: [...range('H', 0, 59)],
  ent: [...range('H', 60, 95), ...range('J', 0, 6), ...range('J', 30, 39), 'R04.0', 'R42'],
  cardiology: ['I', 'R00', 'R01', 'R07', 'R55', 'E78'],
  physiotherapy: ['M', 'S13', 'S16', 'S33', 'S39', 'S43', 'S46', 'S63', 'S83', 'S86', 'S93', 'G54', 'G56', 'G57', 'G81', 'I69', 'R26'],
  psychiatry: ['F', 'G47', 'R45', 'Z63'],
  nutrition: ['E', 'R63', 'K21', 'K58', 'K59', 'D50', 'D51', 'Z71.3'],
  cosmetic: ['L57', 'L60', 'L63', 'L64', 'L65', 'L66', 'L68', 'L70', 'L71', 'L73', 'L80', 'L81', 'L82', 'L90', 'L91', 'L98', 'D18.0', 'D22', 'D23', 'Q82.5', 'I78.1', 'I83.9'],
  general: ['J00', 'J01', 'J02', 'J03', 'J04', 'J06', 'J11', 'J18', 'J20', 'J30', 'J45', 'I10', 'E11', 'E78', 'E66', 'A09', 'K21', 'K29', 'K30', 'K52', 'K58', 'K59.0', 'M54', 'M79', 'N30', 'N39.0', 'R05', 'R10', 'R50', 'R51', 'L50', 'L20', 'H10', 'B34.9', 'D50', 'G43', 'G44.2', 'Z00.0'],
};
PREFIXES.multi = PREFIXES.general;
PREFIXES.other = PREFIXES.general;

const keyOf = (code) => String(code).toUpperCase().replace(/[.\s]/g, '');

/** Prefixes for a specialty key; a type the platform admin added follows the template it was given, else general. */
function prefixesFor(specialty) {
  if (PREFIXES[specialty]) return PREFIXES[specialty];
  try {
    const tpl = require('../platformops/clinic-types').template(specialty); // eslint-disable-line global-require
    if (tpl && PREFIXES[tpl]) return PREFIXES[tpl];
  } catch { /* the general list */ }
  return PREFIXES.general;
}

/** Does this ICD-10 code belong to the specialty's table? */
function belongs(specialty, code) {
  const k = keyOf(code);
  return prefixesFor(specialty).some((p) => k.startsWith(keyOf(p)));
}

/** The specialty's table from a list of entries ({ code, … }), in code order. */
const tableOf = (specialty, entries) => entries.filter((e) => belongs(specialty, e.code));

module.exports = { PREFIXES, prefixesFor, belongs, tableOf };
