// Reference lists shared by the CRM, the catalogue, matching and forms. Labels come from the dictionaries
// (ref.degree.*, ref.field.*…); countries use the ISO code and the runtime's own Arabic / English names.
const DEGREES = ['foundation', 'diploma', 'bachelor', 'master', 'phd', 'language', 'certificate'];
const EDUCATION_LEVELS = ['high_school', 'diploma', 'bachelor', 'master', 'phd'];
const STUDY_MODES = ['on_campus', 'online', 'blended'];
const FIELDS = ['computer_science', 'data_science', 'artificial_intelligence', 'cybersecurity', 'engineering', 'business', 'finance', 'marketing', 'medicine', 'health',
  'nursing', 'pharmacy', 'law', 'architecture', 'design', 'media', 'education', 'psychology', 'social_sciences', 'natural_sciences', 'mathematics', 'hospitality', 'aviation', 'english', 'other'];
const ENGLISH_TESTS = ['ielts', 'toefl', 'pte', 'duolingo'];
const BUDGETS = [['lt10', 0, 10000], ['10_20', 10000, 20000], ['20_35', 20000, 35000], ['35_50', 35000, 50000], ['gt50', 50000, null]];
// Destination slugs before the catalogue tables exist (phase 3 reads the destinations table instead).
const DEFAULT_DESTINATIONS = [
  { slug: 'usa', code: 'US' }, { slug: 'uk', code: 'GB' }, { slug: 'canada', code: 'CA' }, { slug: 'australia', code: 'AU' },
  { slug: 'germany', code: 'DE' }, { slug: 'ireland', code: 'IE' },
];

const ISO = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ '
  + 'EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ '
  + 'LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA '
  + 'RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ');

const names = {};
function countryName(code, locale = 'en') {
  if (!code) return '';
  const key = `${locale}:${code}`;
  if (!names[key]) {
    try { names[key] = new Intl.DisplayNames([locale === 'ar' ? 'ar' : 'en'], { type: 'region' }).of(String(code).toUpperCase()); } catch { names[key] = code; }
  }
  return names[key];
}
const countries = (locale = 'en') => ISO.map((c) => ({ value: c, label: countryName(c, locale) })).sort((a, b) => a.label.localeCompare(b.label, locale));
const flag = (code) => (code && /^[A-Z]{2}$/i.test(code) ? String.fromCodePoint(...code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');
const budgetRange = (key) => { const b = BUDGETS.find((x) => x[0] === key); return b ? { min: b[1], max: b[2] } : null; };

/** Upcoming intake months as YYYY-MM for the next `n` months (forms). */
function intakeOptions(n = 24, from = new Date()) {
  const out = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  for (let i = 0; i < n; i += 1) { out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}
const monthLabel = (ym, locale = 'en') => {
  if (!/^\d{4}-\d{2}$/.test(ym || '')) return ym || '';
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
};

module.exports = { DEGREES, EDUCATION_LEVELS, STUDY_MODES, FIELDS, ENGLISH_TESTS, BUDGETS, DEFAULT_DESTINATIONS, ISO, countryName, countries, flag, budgetRange, intakeOptions, monthLabel };

/** Maps free text ("Data Science", "علم البيانات", "data_science") to a field-of-study key, or null. */
function fieldKey(text) {
  if (!text) return null;
  const v = String(text).trim().toLowerCase();
  if (FIELDS.includes(v)) return v;
  const { dictionaries } = require('../../core/i18n'); // eslint-disable-line global-require
  for (const lang of Object.keys(dictionaries)) {
    const map = (dictionaries[lang].ref || {}).field || {};
    const hit = Object.keys(map).find((k) => map[k].toLowerCase() === v || map[k].toLowerCase().split(' & ')[0] === v);
    if (hit) return hit;
  }
  return null;
}
module.exports.fieldKey = fieldKey;

/** Study destinations for pickers: the catalogue's destinations when present, else the defaults. */
async function destinationOptions(locale = 'en') {
  const knex = require('../../db/knex'); // eslint-disable-line global-require
  if (await knex.schema.hasTable('destinations')) {
    const rows = await knex('destinations').where({ is_active: true }).orderBy('position').select('slug', 'country_code', 'name_en', 'name_ar');
    if (rows.length) return rows.map((r) => ({ value: r.slug, label: (locale === 'ar' ? r.name_ar : r.name_en) || r.name_en, code: r.country_code }));
  }
  return DEFAULT_DESTINATIONS.map((d) => ({ value: d.slug, label: countryName(d.code, locale), code: d.code }));
}
module.exports.destinationOptions = destinationOptions;
