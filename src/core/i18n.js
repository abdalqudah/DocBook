const fs = require('fs');
const path = require('path');
const config = require('../config');

// Each language is a folder of JSON files (one per area) merged into one dictionary.
const dictionaries = {};
for (const locale of config.locales) {
  const dir = path.join(__dirname, '..', 'locales', locale);
  dictionaries[locale] = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    Object.assign(dictionaries[locale], JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
  }
}

const lookup = (dict, key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);

function translator(locale) {
  const dict = dictionaries[locale] || dictionaries[config.defaultLocale];
  const fallback = dictionaries.en;
  return function t(key, vars) {
    let text = lookup(dict, key);
    if (typeof text !== 'string') text = lookup(fallback, key);
    if (typeof text !== 'string') return key;
    if (vars) text = text.replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined ? vars[name] : m));
    return text;
  };
}

/** True when a key exists (used to fall back to raw values for custom categories). */
const has = (locale, key) => typeof lookup(dictionaries[locale] || dictionaries.en, key) === 'string';

function resolveLocale(req) {
  for (const candidate of [req.query?.lang, req.cookies?.db_lang, req.user?.locale]) {
    if (candidate && config.locales.includes(candidate)) return candidate;
  }
  const header = req.headers['accept-language'] || '';
  if (header.toLowerCase().startsWith('ar')) return 'ar';
  return config.defaultLocale;
}

// Field-level validation messages are authored in English; Arabic uses the `vmsg` table.
function translateMessage(locale, message) {
  if (locale === 'en') return message;
  const table = dictionaries[locale]?.vmsg || {};
  return table[message] || table._fallback || message;
}

module.exports = { translator, resolveLocale, dictionaries, translateMessage, has };
