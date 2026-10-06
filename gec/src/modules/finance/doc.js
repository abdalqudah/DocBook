// Helpers to render an invoice in the invoice's own language (not the viewer's interface language).
const i18n = require('../../core/i18n');
const fmt = require('../../core/format');

function docHelpers(i) {
  const locale = i.locale === 'ar' ? 'ar' : 'en';
  return { dt: i18n.translator(locale), dloc: locale, dmoney: (v) => fmt.formatMoney(Number(v || 0), i.currency, locale, 2), ddate: (d) => (d ? fmt.formatDate(d, locale) : '—') };
}
module.exports = { docHelpers };
