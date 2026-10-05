// Arabic / English dictionaries: one folder per language, one JSON file per area, merged.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const dictionaries = {};
function load() {
  for (const locale of config.locales) {
    const dir = path.join(__dirname, '..', 'locales', locale);
    dictionaries[locale] = {};
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      Object.assign(dictionaries[locale], JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
    }
  }
}
load();

const lookup = (dict, key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);

function translator(locale) {
  const dict = dictionaries[locale] || dictionaries[config.defaultLocale];
  return function t(key, vars) {
    let text = lookup(dict, key);
    if (typeof text !== 'string') text = lookup(dictionaries.en, key);
    if (typeof text !== 'string') return key;
    if (vars) text = text.replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined && vars[name] !== null ? vars[name] : m));
    return text;
  };
}

const has = (locale, key) => typeof lookup(dictionaries[locale] || dictionaries.en, key) === 'string';

/** Picks the localized column of a bilingual record: loc(row, 'name', 'ar') → row.name_ar || row.name_en. */
function loc(row, field, locale) {
  if (!row) return '';
  const other = locale === 'ar' ? 'en' : 'ar';
  return row[`${field}_${locale}`] || row[`${field}_${other}`] || row[field] || '';
}

function resolveLocale(req) {
  for (const c of [req.query?.lang, req.cookies?.gec_lang, req.user?.locale]) if (c && config.locales.includes(c)) return c;
  const header = String(req.headers['accept-language'] || '').toLowerCase();
  if (header.startsWith('ar')) return 'ar';
  return config.defaultLocale;
}

/** Field messages are authored in English; Arabic uses the `vmsg` table. */
function translateMessage(locale, message) {
  if (locale === 'en') return message;
  const table = dictionaries[locale]?.vmsg || {};
  return table[message] || message;
}

module.exports = { translator, has, loc, resolveLocale, translateMessage, dictionaries, reload: load };
