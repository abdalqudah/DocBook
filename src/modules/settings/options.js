// Choice lists shared by sign-up, the setup wizard and clinic settings: specialties, time zones and countries.
// Labels for zones and countries come from Intl (localised by the runtime), specialties from auth.json → specialties.*
const { CURRENCIES } = require('../../core/money');

const SPECIALTIES = ['general', 'dentistry', 'dermatology', 'paediatrics', 'obgyn', 'orthopaedics', 'ophthalmology', 'ent', 'cardiology',
  'physiotherapy', 'psychiatry', 'nutrition', 'cosmetic', 'multi', 'other'];

// [IANA zone, ISO country] — Middle East & North Africa first, then common zones elsewhere.
const ZONES = [
  ['Asia/Amman', 'JO'], ['Asia/Riyadh', 'SA'], ['Asia/Dubai', 'AE'], ['Asia/Kuwait', 'KW'], ['Asia/Qatar', 'QA'], ['Asia/Bahrain', 'BH'],
  ['Asia/Muscat', 'OM'], ['Asia/Baghdad', 'IQ'], ['Asia/Beirut', 'LB'], ['Asia/Damascus', 'SY'], ['Asia/Hebron', 'PS'], ['Asia/Aden', 'YE'],
  ['Africa/Cairo', 'EG'], ['Africa/Khartoum', 'SD'], ['Africa/Tripoli', 'LY'], ['Africa/Tunis', 'TN'], ['Africa/Algiers', 'DZ'], ['Africa/Casablanca', 'MA'],
  ['Europe/Istanbul', 'TR'], ['Europe/London', 'GB'], ['Europe/Berlin', 'DE'], ['Europe/Paris', 'FR'], ['Europe/Stockholm', 'SE'],
  ['America/New_York', 'US'], ['America/Chicago', 'US'], ['America/Los_Angeles', 'US'], ['America/Toronto', 'CA'],
  ['Asia/Karachi', 'PK'], ['Asia/Kolkata', 'IN'], ['Asia/Kuala_Lumpur', 'MY'], ['Asia/Singapore', 'SG'], ['Australia/Sydney', 'AU'], ['UTC', ''],
];
const ZONE_IDS = ZONES.map((z) => z[0]);
const COUNTRIES = [...new Set(ZONES.map((z) => z[1]).filter(Boolean))];

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
function zoneOptions(locale) {
  return ZONES.map(([zone, cc]) => {
    const city = zone === 'UTC' ? 'UTC' : zone.split('/').pop().replace(/_/g, ' ');
    const place = cc ? `${regionName(cc, locale)} — ${city}` : city;
    return { value: zone, label: `${place} (${offsetOf(zone)})` };
  });
}

const countryOptions = (locale) => COUNTRIES.map((cc) => ({ value: cc, label: regionName(cc, locale) }))
  .sort((a, b) => a.label.localeCompare(b.label, locale));

const countryForZone = (zone) => (ZONES.find((z) => z[0] === zone) || [])[1] || null;

const specialtyOptions = (t) => SPECIALTIES.map((k) => ({ value: k, label: t(`specialties.${k}`) }));
const currencyOptions = (t) => CURRENCIES.map((c) => ({ value: c, label: `${c} — ${t(`currencies.${c}`)}` }));

module.exports = { SPECIALTIES, ZONES, ZONE_IDS, COUNTRIES, CURRENCIES, zoneOptions, countryOptions, countryForZone, specialtyOptions, currencyOptions, regionName };
