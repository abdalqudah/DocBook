// Choice lists shared by sign-up, the setup wizard and clinic settings: specialties, time zones and countries.
// Labels for zones and countries come from Intl (localised by the runtime), specialties from auth.json → specialties.*
const { CURRENCIES } = require('../../core/money');

const SPECIALTIES = require('../specialty/catalogue').KEYS;

// [IANA zone, ISO country] — Middle East & North Africa first, then common zones elsewhere.
const ZONES = [
  ['Asia/Amman', 'JO'], ['Asia/Riyadh', 'SA'], ['Asia/Dubai', 'AE'], ['Asia/Kuwait', 'KW'], ['Asia/Qatar', 'QA'], ['Asia/Bahrain', 'BH'],
  ['Asia/Muscat', 'OM'], ['Asia/Baghdad', 'IQ'], ['Asia/Beirut', 'LB'], ['Asia/Damascus', 'SY'], ['Asia/Hebron', 'PS'], ['Asia/Aden', 'YE'],
  ['Africa/Cairo', 'EG'], ['Africa/Khartoum', 'SD'], ['Africa/Tripoli', 'LY'], ['Africa/Tunis', 'TN'], ['Africa/Algiers', 'DZ'], ['Africa/Casablanca', 'MA'],
  ['Europe/Istanbul', 'TR'], ['Europe/London', 'GB'], ['Europe/Berlin', 'DE'], ['Europe/Paris', 'FR'], ['Europe/Stockholm', 'SE'],
  ['America/New_York', 'US'], ['America/Chicago', 'US'], ['America/Los_Angeles', 'US'], ['America/Toronto', 'CA'],
  ['Asia/Karachi', 'PK'], ['Asia/Kolkata', 'IN'], ['Asia/Kuala_Lumpur', 'MY'], ['Asia/Singapore', 'SG'], ['Australia/Sydney', 'AU'], ['UTC', ''],
];
// Every country (the dialling list) and, for most, the time zone of its capital and its currency — chosen together
// at sign-up so a clinic anywhere starts with the right day and money.
const GEO = Object.fromEntries(`JO Asia/Amman JOD|SA Asia/Riyadh SAR|AE Asia/Dubai AED|KW Asia/Kuwait KWD|QA Asia/Qatar QAR|BH Asia/Bahrain BHD|OM Asia/Muscat OMR|IQ Asia/Baghdad IQD|LB Asia/Beirut LBP|SY Asia/Damascus SYP|PS Asia/Hebron ILS|YE Asia/Aden YER|EG Africa/Cairo EGP|SD Africa/Khartoum SDG|LY Africa/Tripoli LYD|TN Africa/Tunis TND|DZ Africa/Algiers DZD|MA Africa/Casablanca MAD|MR Africa/Nouakchott MRU|DJ Africa/Djibouti DJF|SO Africa/Mogadishu SOS|KM Indian/Comoro KMF|TR Europe/Istanbul TRY|IR Asia/Tehran IRR|CY Asia/Nicosia EUR|GR Europe/Athens EUR|GB Europe/London GBP|IE Europe/Dublin EUR|DE Europe/Berlin EUR|AT Europe/Vienna EUR|CH Europe/Zurich CHF|FR Europe/Paris EUR|BE Europe/Brussels EUR|NL Europe/Amsterdam EUR|LU Europe/Luxembourg EUR|IT Europe/Rome EUR|ES Europe/Madrid EUR|PT Europe/Lisbon EUR|SE Europe/Stockholm SEK|NO Europe/Oslo NOK|DK Europe/Copenhagen DKK|FI Europe/Helsinki EUR|IS Atlantic/Reykjavik ISK|PL Europe/Warsaw PLN|CZ Europe/Prague CZK|SK Europe/Bratislava EUR|HU Europe/Budapest HUF|RO Europe/Bucharest RON|BG Europe/Sofia BGN|RS Europe/Belgrade RSD|HR Europe/Zagreb EUR|SI Europe/Ljubljana EUR|BA Europe/Sarajevo BAM|ME Europe/Podgorica EUR|MK Europe/Skopje MKD|AL Europe/Tirane ALL|UA Europe/Kyiv UAH|MD Europe/Chisinau MDL|LT Europe/Vilnius EUR|LV Europe/Riga EUR|EE Europe/Tallinn EUR|RU Europe/Moscow RUB|GE Asia/Tbilisi GEL|AM Asia/Yerevan AMD|AZ Asia/Baku AZN|KZ Asia/Almaty KZT|UZ Asia/Tashkent UZS|AF Asia/Kabul AFN|PK Asia/Karachi PKR|IN Asia/Kolkata INR|BD Asia/Dhaka BDT|LK Asia/Colombo LKR|NP Asia/Kathmandu NPR|MV Indian/Maldives MVR|CN Asia/Shanghai CNY|HK Asia/Hong_Kong HKD|TW Asia/Taipei TWD|JP Asia/Tokyo JPY|KR Asia/Seoul KRW|MY Asia/Kuala_Lumpur MYR|SG Asia/Singapore SGD|ID Asia/Jakarta IDR|PH Asia/Manila PHP|TH Asia/Bangkok THB|VN Asia/Ho_Chi_Minh VND|BN Asia/Brunei BND|AU Australia/Sydney AUD|NZ Pacific/Auckland NZD|US America/New_York USD|CA America/Toronto CAD|MX America/Mexico_City MXN|BR America/Sao_Paulo BRL|AR America/Argentina/Buenos_Aires ARS|CL America/Santiago CLP|CO America/Bogota COP|PE America/Lima PEN|NG Africa/Lagos NGN|GH Africa/Accra GHS|KE Africa/Nairobi KES|ET Africa/Addis_Ababa ETB|TZ Africa/Dar_es_Salaam TZS|UG Africa/Kampala UGX|RW Africa/Kigali RWF|ZA Africa/Johannesburg ZAR|SN Africa/Dakar XOF|CI Africa/Abidjan XOF|CM Africa/Douala XAF|SS Africa/Juba SSP|MT Europe/Malta EUR`.split('|').map((x) => { const [cc, zone, cur] = x.trim().split(' '); return [cc, { zone, currency: cur }]; }));
let ALL_ZONES = [];
try { ALL_ZONES = Intl.supportedValuesOf('timeZone'); } catch { ALL_ZONES = []; }
const ZONE_IDS = [...new Set([...ZONES.map((z) => z[0]), ...Object.values(GEO).map((g) => g.zone), ...ALL_ZONES])];
const COUNTRIES = [...new Set([...ZONES.map((z) => z[1]).filter(Boolean), ...require('../telehealth/countries').LIST.map((c) => c.cc)])]; // eslint-disable-line global-require

function offsetOf(zone) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part ? part.value.replace('GMT', 'GMT') : 'GMT';
  } catch { return 'GMT'; }
}

function regionName(code, locale) {
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(code) || code; } catch { return code; }
}

/** [{ value, label }] for a time-zone <select>, e.g. "الأردن — عمّان (GMT+3)". */
const zoneCache = {};
function zoneOptions(locale) {
  if (zoneCache[locale]) return zoneCache[locale];
  const known = ZONES.map(([zone, cc]) => {
    const city = zone === 'UTC' ? 'UTC' : zone.split('/').pop().replace(/_/g, ' ');
    const place = cc ? `${regionName(cc, locale)} — ${city}` : city;
    return { value: zone, label: `${place} (${offsetOf(zone)})` };
  });
  // then every other zone, by name ("Europe/Madrid (GMT+2)")
  const seen = new Set(known.map((z) => z.value));
  const rest = ZONE_IDS.filter((z) => !seen.has(z)).sort().map((zone) => ({ value: zone, label: `${zone.replace(/_/g, ' ')} (${offsetOf(zone)})` }));
  zoneCache[locale] = [...known, ...rest];
  return zoneCache[locale];
}

const countryOptions = (locale) => COUNTRIES.map((cc) => ({ value: cc, label: regionName(cc, locale) }))
  .sort((a, b) => a.label.localeCompare(b.label, locale));

const countryForZone = (zone) => (ZONES.find((z) => z[0] === zone) || [])[1] || (Object.entries(GEO).find(([, g]) => g.zone === zone) || [])[0] || null;
/** The capital's time zone and the currency of a country (or null). */
const geoOf = (cc) => GEO[String(cc || '').toUpperCase()] || null;

const specialtyOptions = (t) => SPECIALTIES.map((k) => ({ value: k, label: t(`specialties.${k}`) }));
const currencyName = (c, t, locale) => { const k = `currencies.${c}`; const v = t(k); if (v !== k) return v; try { return new Intl.DisplayNames([locale === 'en' ? 'en' : 'ar'], { type: 'currency' }).of(c) || c; } catch { return c; } };
const currencyOptions = (t, locale = 'ar') => CURRENCIES.map((c) => ({ value: c, label: `${c} — ${currencyName(c, t, locale)}` }));

module.exports = { GEO, geoOf, SPECIALTIES, ZONES, ZONE_IDS, COUNTRIES, CURRENCIES, zoneOptions, countryOptions, countryForZone, specialtyOptions, currencyOptions, regionName };
