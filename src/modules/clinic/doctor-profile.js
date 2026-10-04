// A doctor's full profile shown on their page of the clinic website: years of experience, languages spoken, career
// (posts held), professional memberships and areas of focus. Lists are one item per line, in Arabic and English.
// Stored as JSON in doctors.profile: { years, languages: { ar, en }, career: { ar, en }, memberships: { ar, en }, focus: { ar, en } }.
const LISTS = ['career', 'memberships', 'focus'];
const MAX_LIST = 2000;
const text = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const line = (v, max) => text(v, max).replace(/\s*\n\s*/g, ' ');

/** A clean profile from a raw object (stored JSON or import data). */
function clean(raw) {
  let o = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw || '{}'); } catch { o = {}; } }
  o = o && typeof o === 'object' ? o : {};
  const years = Math.round(Number(o.years));
  const out = { years: Number.isFinite(years) && years > 0 && years < 80 ? years : null, languages: { ar: line(o.languages && o.languages.ar, 120), en: line(o.languages && o.languages.en, 120) } };
  for (const k of LISTS) out[k] = { ar: text(o[k] && o[k].ar, MAX_LIST), en: text(o[k] && o[k].en, MAX_LIST) };
  return out;
}

/** The profile from the doctor form fields (profile_years, profile_languages_ar, profile_career_en, …). */
function fromForm(input = {}) {
  const raw = { years: input.profile_years, languages: { ar: input.profile_languages_ar, en: input.profile_languages_en } };
  for (const k of LISTS) raw[k] = { ar: input[`profile_${k}_ar`], en: input[`profile_${k}_en`] };
  return clean(raw);
}

const empty = (p) => !p.years && !p.languages.ar && !p.languages.en && LISTS.every((k) => !p[k].ar && !p[k].en);
/** JSON to store (null when nothing is filled in). */
const toStore = (p) => (empty(p) ? null : JSON.stringify(p));

/** The profile in the visitor's language (falling back to the other one): lists as arrays of lines. */
function view(raw, locale, { education = '', educationOther = '' } = {}) {
  const p = clean(raw);
  const other = locale === 'en' ? 'ar' : 'en';
  const pick = (v) => (v && (v[locale] || v[other])) || '';
  const lines = (s) => String(s || '').split('\n').map((x) => x.replace(/^[\s•\-–*·]+/, '').trim()).filter(Boolean);
  return {
    years: p.years, languages: pick(p.languages),
    career: lines(pick(p.career)), memberships: lines(pick(p.memberships)), focus: lines(pick(p.focus)),
    education: lines(education || educationOther),
  };
}

module.exports = { LISTS, clean, fromForm, toStore, view };
