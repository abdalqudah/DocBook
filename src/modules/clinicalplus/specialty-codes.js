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
  // Specialties added with the full catalogue (src/modules/specialty/catalogue.js).
  internal: ['I10', 'I11', 'I20', 'I25', 'I48', 'I50', 'E10', 'E11', 'E03', 'E05', 'E66', 'E78', 'E55', 'D50', 'D51', 'K21', 'K25', 'K29', 'K58', 'K59', 'K76.0', 'J44', 'J45', 'J18', 'N18', 'N39.0', 'M10', 'R50', 'R53', 'R10', 'R07', 'Z00.0'],
  geriatrics: ['F00', 'F01', 'F03', 'F05', 'G30', 'G20', 'R26', 'R29.6', 'R41.0', 'M81', 'M80', 'M17', 'I10', 'I48', 'I50', 'E11', 'N39.4', 'R32', 'L89', 'H25', 'H91.1', 'R63.4', 'Z74', 'Z91.81', 'W19'],
  fertility: ['N97', 'N46', 'E28.2', 'N80', 'Z31', 'N98', 'N96', 'O02', 'O03', 'E22.1', 'N70', 'N91', 'N92', 'Q50', 'Q51', 'Q52', 'Q53', 'Q55', 'Z32'],
  orthodontics: ['K07', 'K08', 'K00', 'K03.5', 'K10.0', 'Q35', 'Q36', 'Q37', 'M26'],
  oral_surgery: [...range('K', 0, 14), 'S02', 'M26', 'M27', 'D16.4', 'D16.5', 'K09', 'Q35', 'Q36', 'Q37', 'T81.4', 'C02', 'C03', 'C04', 'C05', 'C06'],
  plastic: ['L90', 'L91', 'T20', 'T21', 'T22', 'T23', 'T24', 'T25', 'T30', 'T31', 'S01', 'S51', 'S61', 'Q35', 'Q36', 'Q37', 'N62', 'N64.8', 'E65', 'L98', 'Z42', 'C43', 'C44', 'D22', 'D23', 'T81.4', 'L72', 'Q17', 'M72.0'],
  optometry: ['H52', 'H53', 'H50', 'H10', 'H04.1', 'H40', 'H25', 'H26', 'H35.3', 'H18.6', 'H54', 'H57.1', 'Z01.0'],
  audiology: ['H90', 'H91', 'H93.1', 'H83.3', 'H92', 'H61.2', 'H65', 'H66', 'H72', 'H81', 'R42', 'Z01.1', 'F80.4'],
  speech: ['F80', 'R47', 'R48', 'R49', 'F98.5', 'F98.6', 'R13', 'F84', 'F70', 'F71', 'F72', 'F73', 'F79', 'Q35', 'Q36', 'Q37', 'H90', 'I69', 'G80'],
  pulmonology: [...range('J', 0, 99), 'R05', 'R06', 'R09', 'R04.2', 'G47.3', 'A15', 'A16', 'C34', 'E84', 'I26', 'I27'],
  gastroenterology: [...range('K', 20, 95), 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R17', 'R18', 'R19', 'B15', 'B16', 'B17', 'B18', 'B19', 'A04.7', 'A08', 'A09', 'C15', 'C16', 'C18', 'C19', 'C20', 'C22', 'C25', 'D12', 'D13', 'E73', 'Z12.1'],
  endocrinology: ['E', 'R73', 'M81', 'M80', 'Q96', 'D35.0', 'D35.2', 'D44', 'C73', 'L68.0', 'N91', 'N97', 'R63.5', 'R63.4', 'Z13.1'],
  nephrology: [...range('N', 0, 29), 'I12', 'I13', 'I15', 'E87', 'E83.5', 'R80', 'R31', 'R34', 'Z49', 'Z94.0', 'Z99.2', 'D63.8', 'E11.2', 'E10.2', 'Q60', 'Q61', 'Q62', 'Q63'],
  urology: ['N13', 'N20', 'N21', 'N23', ...range('N', 30, 53), 'R30', 'R31', 'R32', 'R33', 'R35', 'R36', 'R39', 'C61', 'C62', 'C64', 'C67', 'D29', 'D30', 'Q53', 'Q54', 'Q62', 'Q64', 'Z30.2', 'S37'],
  neurology: ['G', 'R51', 'R25', 'R26', 'R27', 'R20', 'R29', 'R42', 'R40', 'R41', 'R55', 'R56', ...range('I', 60, 69), 'F00', 'F01', 'F02', 'F03', 'F44.5', 'M54.1', 'M79.2', 'E51.2', 'E53.8', 'S06'],
  neurosurgery: ['G', 'S06', 'S12', 'S13', 'S14', 'S22', 'S32', 'S33', 'S34', 'M47', 'M48', 'M50', 'M51', 'M53', 'M54', 'M43', 'M41', 'C70', 'C71', 'C72', 'D32', 'D33', 'D43', 'I60', 'I61', 'I62', 'I67.1', 'Q01', 'Q03', 'Q05', 'Q06', 'Q07', 'T85'],
  psychology: ['F', 'Z63', 'Z60', 'Z56', 'Z73', 'R45', 'G47', 'T74', 'Z91.5'],
  sports: ['S', 'M', 'T14', 'T79.6', 'G56.0', 'G57'],
  rheumatology: [...range('M', 0, 36), 'M45', 'M46', 'M79', 'M81', 'M80', 'M10', 'M11', 'M15', 'M16', 'M17', 'M18', 'M19', 'L40.5', 'D86', 'I73.0', 'R76', 'R70', 'N04', 'E79.0'],
  pain: ['M54', 'M79', 'M25.5', 'M53', 'M47', 'M51', 'M75', 'M77', 'G43', 'G44', 'G50', 'G54', 'G56', 'G57', 'G58', 'G62', 'G89', 'R52', 'B02.2', 'G35', 'C79.5', 'M89.0', 'M96.1'],
  oncology: ['C', 'D0', 'D3', 'D4', 'Z51.1', 'Z51.0', 'Z85', 'Z08', 'Z12', 'R59', 'R63.4', 'D61.1', 'D70', 'R53', 'G89.3', 'E88.3'],
  haematology: [...range('D', 50, 89), 'C81', 'C82', 'C83', 'C84', 'C85', 'C88', 'C90', 'C91', 'C92', 'C93', 'C94', 'C95', 'C96', 'E83.1', 'R71', 'R72', 'R79', 'Z79.01', 'I26', 'I80', 'I82', 'O99.0'],
  infectious: ['A', 'B', 'J09', 'J10', 'J11', 'J12', 'J13', 'J14', 'J15', 'J18', 'N39.0', 'N10', 'L01', 'L02', 'L03', 'L08', 'R50', 'R56.0', 'U07', 'Z20', 'Z21', 'Z22', 'Z23', 'Z29', 'T80.2', 'M86', 'M00', 'I33', 'G00', 'G03', 'G04', 'K65', 'K81.0', 'H66', 'J01', 'J02', 'J03', 'J20'],
  allergy: ['J30', 'J31', 'J32', 'J33', 'J45', 'J46', 'L20', 'L23', 'L24', 'L27', 'L50', 'L56.3', 'T78', 'T88.6', 'T88.7', 'Z88', 'Z91.0', 'H10.1', 'H10.4', 'K52.2', 'D80', 'D81', 'D82', 'D83', 'D84', 'D72.1', 'K20.0', 'R06.2'],
  general_surgery: ['K35', 'K36', 'K37', 'K38', 'K40', 'K41', 'K42', 'K43', 'K44', 'K45', 'K46', 'K56', 'K57', 'K60', 'K61', 'K62', 'K63', 'K64', 'K80', 'K81', 'K82', 'K83', 'K85', 'K91', 'L02', 'L03', 'L05', 'L72', 'D17', 'N62', 'N60', 'N61', 'N63', 'E04', 'E05', 'E21', 'R10', 'R19.0', 'T81', 'S31', 'S36', 'C16', 'C18', 'C20', 'C50', 'C73', 'D12', 'D24', 'I83', 'I84', 'Z48'],
  vascular: [...range('I', 70, 89), 'I95', 'I96', 'I99', 'L97', 'L98.4', 'E10.5', 'E11.5', 'E14.5', 'R02', 'Q27', 'Q28', 'T82', 'Z95.8', 'Z86.7', 'I26', 'I65', 'I63.2'],
  general: ['J00', 'J01', 'J02', 'J03', 'J04', 'J06', 'J11', 'J18', 'J20', 'J30', 'J45', 'I10', 'E11', 'E78', 'E66', 'A09', 'K21', 'K29', 'K30', 'K52', 'K58', 'K59.0', 'M54', 'M79', 'N30', 'N39.0', 'R05', 'R10', 'R50', 'R51', 'L50', 'L20', 'H10', 'B34.9', 'D50', 'G43', 'G44.2', 'Z00.0'],
};
PREFIXES.multi = PREFIXES.general;
PREFIXES.other = PREFIXES.general;
PREFIXES.family = PREFIXES.general;

const keyOf = (code) => String(code).toUpperCase().replace(/[.\s]/g, '');

/** Prefixes for a specialty key; a type the platform admin added follows the template it was given, else general. */
function prefixesFor(specialty) {
  if (PREFIXES[specialty]) return PREFIXES[specialty];
  const own = require('../specialty/catalogue').pick(specialty, PREFIXES); // eslint-disable-line global-require -- a narrower specialty uses its broader one's
  if (own) return own;
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
