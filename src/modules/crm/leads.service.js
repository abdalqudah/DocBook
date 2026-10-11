// CRM → find clinics. A saved search ("dental clinic", a city, a country) asks the Google Places API (Text Search, with
// the platform's own API key) or OpenStreetMap (free, no key: the city's area from Nominatim, then the clinics in it from
// Overpass) for the places it knows — name, address, phone, website, rating — and reads the public e-mail address from
// each clinic's website. Places can also be uploaded from a CSV file (the Google Maps collector the admin runs in their
// own browser, or any list). Searches marked "auto" run again every day: a place that
// was not in the earlier runs is flagged as new on Google (often a clinic that just opened) and the admin is notified.
// Places are leads until the admin adds them to the CRM (one contact each, matched to an existing one by phone or
// e-mail) or ignores them.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const outbound = require('../../core/http');
const { E } = require('../../core/errors');

const crypto = require('crypto');

const KEY = 'crm_google';
const SOURCES = ['google', 'osm', 'import'];
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const MAX_IMPORT = 3000;
const PLACES = 'https://places.googleapis.com/v1/places:searchText';
const FIELDS = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents', 'places.nationalPhoneNumber', 'places.internationalPhoneNumber',
  'places.websiteUri', 'places.googleMapsUri', 'places.location', 'places.rating', 'places.userRatingCount', 'places.businessStatus', 'nextPageToken'].join(',');
const PAGES = 3; // Google returns at most 60 places (3 × 20) for one search
const EMAILS_PER_RUN = 25;
const STATUSES = ['new', 'added', 'ignored'];

// Outbound requests go through the SSRF-safe client; tests swap it for a fake Google and fake websites.
let transport = (url, opts) => outbound.request(url, opts);
const setTransport = (fn) => { transport = fn || ((url, opts) => outbound.request(url, opts)); };

const str = (v, n) => { const s = String(v === undefined || v === null ? '' : v).trim().slice(0, n); return s || null; };
const webUrl = (v) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(v || '')) ? String(v).slice(0, 255) : null); // only plain web links are kept
const parse = (v) => { try { return JSON.parse(v || '{}') || {}; } catch { return {}; } };

// ---------------------------------------------------------------- settings (the API key, encrypted)
async function rawSettings() { return parse((await knex('platform_settings').where({ key: KEY }).first('value') || {}).value); }
async function settings() { const s = await rawSettings(); return { hasKey: !!s.api_key, emails: s.emails !== false }; }
async function apiKey() { const s = await rawSettings(); return s.api_key ? secrets.decrypt(s.api_key) : null; }

async function saveSettings(ctx, input = {}) {
  const s = await rawSettings();
  const key = String(input.api_key || '').trim();
  if (key) { if (!/^[A-Za-z0-9_-]{20,100}$/.test(key)) throw E.validation({ api_key: 'Enter a valid API key.' }); s.api_key = secrets.encrypt(key); }
  if (input.remove_key === '1') delete s.api_key;
  s.emails = input.emails === '1' || input.emails === 'on' || input.emails === true;
  const value = JSON.stringify(s);
  await knex('platform_settings').insert({ key: KEY, value }).onConflict('key').merge({ value, updated_at: new Date() });
  await audit.record({ ...ctx, businessId: null }, 'crm.google_settings', { newValues: { key_set: !!s.api_key, emails: s.emails } });
  return settings();
}

// ---------------------------------------------------------------- searches
async function searches() {
  const rows = await knex('crm_lead_searches').orderBy('id', 'desc');
  const counts = await knex('crm_leads').groupBy('search_id').select('search_id').count({ n: '*' }).sum({ fresh: knex.raw('CASE WHEN is_new_place = 1 AND status = ? THEN 1 ELSE 0 END', ['new']) });
  const by = Object.fromEntries(counts.map((c) => [c.search_id, { n: Number(c.n), fresh: Number(c.fresh || 0) }]));
  return rows.map((r) => ({ ...r, leads: (by[r.id] || {}).n || 0, fresh: (by[r.id] || {}).fresh || 0 }));
}

async function saveSearch(ctx, input = {}) {
  const query = str(input.query, 190);
  if (!query) throw E.validation({ query: 'Required.' });
  const country = /^[A-Z]{2}$/.test(String(input.country || '').toUpperCase()) ? String(input.country).toUpperCase() : null;
  const source = input.source === 'osm' ? 'osm' : 'google';
  if (source === 'osm' && !str(input.city, 120)) throw E.validation({ city: 'Enter the city: the free map searches one city at a time.' });
  const [id] = await knex('crm_lead_searches').insert({ query, city: str(input.city, 120), country, source, auto: input.auto === '1' || input.auto === 'on', created_by: ctx.userId || null });
  await audit.record({ ...ctx, businessId: null }, 'crm.lead_search_created', { entityType: 'crm_lead_search', entityId: id, newValues: { query, city: input.city, country } });
  return id;
}

async function setAuto(ctx, id, on) {
  await knex('crm_lead_searches').where({ id }).update({ auto: !!on, updated_at: new Date() });
}

async function removeSearch(ctx, id) {
  const s = await knex('crm_lead_searches').where({ id }).first();
  if (!s) throw E.notFound('Search');
  await knex('crm_leads').where({ search_id: id, status: 'new' }).del(); // leads already added or ignored stay (not shown again)
  await knex('crm_lead_searches').where({ id }).del();
  await audit.record({ ...ctx, businessId: null }, 'crm.lead_search_deleted', { entityType: 'crm_lead_search', entityId: id, oldValues: { query: s.query, city: s.city } });
}

// ---------------------------------------------------------------- Google
function component(place, type, short = true) {
  const c = (place.addressComponents || []).find((x) => (x.types || []).includes(type));
  return c ? (short ? c.shortText : c.longText) : null;
}

/** One Text Search call → { places, next }. Errors carry Google's message (a wrong key, the API not enabled…). */
async function searchPage(key, body) {
  const res = await transport(PLACES, {
    method: 'POST', body: JSON.stringify(body), timeoutMs: 15_000, maxBytes: 2_000_000,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key, 'x-goog-fieldmask': FIELDS },
  });
  const data = parse(res.body);
  if (res.status !== 200) throw E.validation({ google: String((data.error && data.error.message) || `Google answered ${res.status}.`).slice(0, 250) });
  return { places: data.places || [], next: data.nextPageToken || null };
}

// ---------------------------------------------------------------- e-mails from the clinic's website
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
const JUNK = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|sentry|wixpress|domain|email)\.|^(name|user|your|info@example)/i;

function emailsIn(html) {
  const text = String(html || '').replace(/&#64;|&#x40;|\s*\[at\]\s*|\s*\(at\)\s*/gi, '@');
  const found = [...new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase().replace(/^mailto:/, '')))];
  return found.filter((e) => !JUNK.test(e) && e.length <= 190);
}

async function fetchPage(url) {
  const u = String(url || '').replace(/^http:\/\//i, 'https://'); // only https leaves the server
  const res = await transport(u, { method: 'GET', timeoutMs: 8_000, maxBytes: 600_000, redirects: 3, headers: { accept: 'text/html' } });
  return res.status === 200 ? res.body : '';
}

/** The public e-mail address on a website: the home page, then its contact page. The site's own domain first. */
async function emailFromSite(site) {
  let host = '';
  try { host = new URL(site).hostname.replace(/^www\./, ''); } catch { return null; }
  const pick = (list) => list.find((e) => e.endsWith(`@${host}`) || e.endsWith(`.${host}`)) || list[0] || null;
  try {
    const home = await fetchPage(site);
    let found = emailsIn(home);
    if (!found.length) {
      const m = home.match(/href=["']([^"']*(?:contact|kontakt|about|اتصل|تواصل)[^"']*)["']/i);
      if (m) {
        const next = new URL(m[1], site);
        if (next.hostname.replace(/^www\./, '') === host) found = emailsIn(await fetchPage(next.toString()));
      }
    }
    return pick(found);
  } catch { return null; }
}

// ---------------------------------------------------------------- OpenStreetMap (free, no key)
const GENERIC = /^(عياد[ةه]|عيادات|مركز|مراكز|مجمع|طب|طبي[ةه]?|طبيب|دكتور|د\.?|في|clinics?|medical|centers?|centres?|doctors?|health|in|the)$/i;
const SPECIALTIES = [[/أسنان|اسنان|dent/i, 'dentist'], [/جلد|derma/i, 'dermatology'], [/أطفال|اطفال|paediat|pediat/i, 'paediatrics'],
  [/نسائي|توليد|gyn|obstet/i, 'gynaecology'], [/عيون|ophthal|eye/i, 'ophthalmology'], [/عظام|ortho/i, 'orthopaedics'], [/قلب|cardio/i, 'cardiology'],
  [/أنف|انف|أذن|اذن|otolaryn|\bent\b/i, 'otolaryngology'], [/تجميل|plastic|cosmetic/i, 'plastic_surgery'], [/باطن|internal/i, 'internal'],
  [/علاج طبيعي|physio/i, 'physiotherapy'], [/نفسي|psych/i, 'psychiatry']];
const first = (v) => String(v || '').split(';')[0].trim();

/** What a free-text search means on the map: dental only, a specialty, and any other words to find in the name. */
function osmQuery(text) {
  const words = String(text || '').split(/[\s,،]+/).filter(Boolean);
  const specs = SPECIALTIES.filter(([re]) => re.test(text)).map(([, v]) => v);
  const rest = words.filter((w) => !GENERIC.test(w) && !GENERIC.test(w.replace(/^ال/, '')) && !SPECIALTIES.some(([re]) => re.test(w)));
  return { dental: specs.length === 1 && specs[0] === 'dentist', specs: specs.filter((v) => v !== 'dentist'), rest };
}

async function osmPlaces(s, { locale }) {
  const geo = await transport(`${NOMINATIM}?format=jsonv2&limit=1&accept-language=${locale === 'en' ? 'en' : 'ar'}&q=${encodeURIComponent(s.city)}${s.country ? `&countrycodes=${s.country.toLowerCase()}` : ''}`,
    { method: 'GET', timeoutMs: 15_000, maxBytes: 200_000, headers: { accept: 'application/json' } });
  const list = parse(geo.body);
  const area = Array.isArray(list) ? list[0] : null;
  if (geo.status !== 200 || !area || !area.boundingbox) throw E.validation({ google: `The map could not find "${s.city}". Check the city's name.` });
  const [south, north, west, east] = area.boundingbox.map(Number);
  const box = `(${south},${west},${north},${east})`;
  const q = osmQuery(s.query);
  const kinds = q.dental ? ['nwr["amenity"="dentist"]', 'nwr["healthcare"="dentist"]'] : ['nwr["amenity"~"^(clinic|doctors|dentist)$"]', 'nwr["healthcare"~"^(clinic|doctor|dentist|centre|physiotherapist)$"]'];
  const data = `[out:json][timeout:30];(${kinds.map((k) => `${k}${box};`).join('')});out center tags 400;`;
  const res = await transport(OVERPASS, { method: 'POST', body: `data=${encodeURIComponent(data)}`, timeoutMs: 45_000, maxBytes: 8_000_000, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
  if (res.status !== 200) throw E.validation({ google: res.status === 429 || res.status === 504 ? 'The free map is busy. Try again in a minute.' : `The map answered ${res.status}.` });
  const out = [];
  (parse(res.body).elements || []).forEach((e) => {
    const t = e.tags || {};
    const name = str(t[`name:${locale === 'en' ? 'en' : 'ar'}`] || t.name || t['name:en'] || t['name:ar'], 190);
    if (!name) return;
    const spec = String(t['healthcare:speciality'] || '').toLowerCase();
    if (q.specs.length && !q.specs.some((v) => spec.includes(v) || SPECIALTIES.find(([, x]) => x === v)[0].test(name))) return;
    if (q.rest.length && !q.rest.some((w) => name.toLowerCase().includes(w.toLowerCase()))) return;
    const email = first(t.email || t['contact:email']).toLowerCase();
    out.push({
      place_id: `osm:${e.type}/${e.id}`, name,
      address: str([[t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '), t['addr:suburb'] || t['addr:district'], t['addr:city']].filter(Boolean).join('، '), 255),
      city: str(t['addr:city'] || s.city, 120), country: s.country || null,
      phone: str(first(t.phone || t['contact:phone'] || t['contact:mobile']), 40), website: webUrl(first(t.website || t['contact:website'])),
      email: /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,24}$/.test(email) ? email.slice(0, 190) : null,
      maps_url: `https://www.openstreetmap.org/${e.type}/${e.id}`, lat: e.lat !== undefined ? e.lat : (e.center || {}).lat || null, lng: e.lon !== undefined ? e.lon : (e.center || {}).lon || null,
      category: str(spec || t.amenity || t.healthcare, 120), rating: null, reviews: 0,
    });
  });
  return out;
}

// ---------------------------------------------------------------- Google
async function googlePlaces(s, { locale }) {
  const key = await apiKey();
  if (!key) throw E.validation({ google: 'Add the Google Maps API key first.' });
  const body = { textQuery: [s.query, s.city].filter(Boolean).join(' '), languageCode: locale === 'en' ? 'en' : 'ar', pageSize: 20 };
  if (s.country) body.regionCode = s.country;
  const out = [];
  let token = null;
  for (let i = 0; i < PAGES; i += 1) {
    const page = await searchPage(key, token ? { ...body, pageToken: token } : body); // eslint-disable-line no-await-in-loop
    page.places.forEach((p) => {
      if (!p.id || p.businessStatus === 'CLOSED_PERMANENTLY') return;
      out.push({
        place_id: p.id, name: str(p.displayName && p.displayName.text, 190) || '—', address: str(p.formattedAddress, 255),
        city: str(component(p, 'locality', false) || component(p, 'administrative_area_level_1', false), 120),
        country: (component(p, 'country') || s.country || '').toUpperCase().slice(0, 2) || null,
        phone: str(p.internationalPhoneNumber || p.nationalPhoneNumber, 40), website: webUrl(p.websiteUri), maps_url: webUrl(p.googleMapsUri),
        lat: p.location ? p.location.latitude : null, lng: p.location ? p.location.longitude : null,
        rating: p.rating === undefined ? null : p.rating, reviews: p.userRatingCount === undefined ? 0 : p.userRatingCount,
      });
    });
    token = page.next;
    if (!token) break;
  }
  return out;
}

/** Saves a place found by a search: new (flagged as new on the map after the search's first run) or updated. */
async function saveLead(s, place, { firstRun, now }) {
  const { place_id: placeId, ...row } = place;
  const known = await knex('crm_leads').where({ place_id: placeId }).first('id');
  if (known) {
    await knex('crm_leads').where({ id: known.id }).update({ ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined && v !== '')), last_seen_at: now });
    return false;
  }
  await knex('crm_leads').insert({ ...row, place_id: placeId, search_id: s.id, is_new_place: !firstRun, first_seen_at: now, last_seen_at: now });
  return true;
}

// ---------------------------------------------------------------- running a search
async function run(ctx, searchId, { locale = 'ar' } = {}) {
  const s = await knex('crm_lead_searches').where({ id: searchId }).first();
  if (!s) throw E.notFound('Search');
  if (s.source === 'import') throw E.validation({ google: 'An uploaded list is not searched again. Upload the file again to update it.' });
  const firstRun = !s.runs;
  const now = new Date();
  let found = 0; let added = 0; let fresh = 0;
  try {
    const places = await (s.source === 'osm' ? osmPlaces : googlePlaces)(s, { locale });
    for (const p of places) { // eslint-disable-line no-restricted-syntax
      found += 1;
      if (await saveLead(s, p, { firstRun, now })) { added += 1; if (!firstRun) fresh += 1; } // eslint-disable-line no-await-in-loop
    }
    await knex('crm_lead_searches').where({ id: s.id }).update({ runs: s.runs + 1, last_run_at: now, last_error: null, updated_at: now });
  } catch (e) {
    await knex('crm_lead_searches').where({ id: s.id }).update({ last_run_at: now, last_error: String((e.details && (e.details.google || e.details.city)) || e.message).slice(0, 250) });
    throw e;
  }
  if ((await settings()).emails) await fillEmails(EMAILS_PER_RUN);
  if (fresh) {
    const pnotify = require('../platformnotify/notify.service'); // eslint-disable-line global-require
    await pnotify.admin('crm_new_places', { n: fresh, query: [s.query, s.city].filter(Boolean).join(' — ') }, { link: `/admin/crm/finder?search=${s.id}&fresh=1`, severity: 'success' });
  }
  return { found, added, fresh };
}

// ---------------------------------------------------------------- a list from a file (CSV)
/** RFC 4180 CSV → rows of cells (quoted cells, "" inside quotes, CR LF or LF; a leading BOM dropped; , or ; or tab). */
function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}
const HEADS = {
  name: ['name', 'title', 'الاسم', 'اسم'], phone: ['phone', 'tel', 'telephone', 'mobile', 'الهاتف', 'رقم الهاتف', 'الجوال'], website: ['website', 'site', 'web', 'الموقع', 'الموقع الإلكتروني'],
  email: ['email', 'e-mail', 'mail', 'البريد', 'البريد الإلكتروني'], address: ['address', 'العنوان'], city: ['city', 'المدينة'], country: ['country', 'الدولة'],
  maps_url: ['maps_url', 'maps', 'google maps', 'link', 'url', 'الرابط'], rating: ['rating', 'التقييم'], reviews: ['reviews', 'reviews_count', 'المراجعات'],
  category: ['category', 'type', 'التصنيف', 'النوع'], place_id: ['place_id', 'placeid', 'id'], query: ['query', 'البحث'],
};

/** Places from a CSV file → a search marked "uploaded", its places as leads (an address already known is updated). */
async function importFile(ctx, file, input = {}) {
  if (!file || !file.buffer || !file.buffer.length) throw E.validation({ file: 'Choose a CSV file.' });
  if (file.buffer.length > 5 * 1024 * 1024) throw E.validation({ file: 'The file is larger than 5 MB.' });
  const rows = parseCsv(file.buffer.toString('utf8'));
  const head = (rows.shift() || []).map((h) => String(h).trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(HEADS).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
  if (col.name < 0) throw E.validation({ file: 'The file needs a "name" column (the first row holds the column names).' });
  const country = /^[A-Z]{2}$/.test(String(input.country || '').toUpperCase()) ? String(input.country).toUpperCase() : null;
  const get = (r, k) => (col[k] >= 0 ? String(r[col[k]] || '').trim() : '');
  const label = str(input.label, 190) || get(rows[0] || [], 'query') || str(String(file.originalname || '').replace(/\.csv$/i, ''), 190) || 'CSV';
  const now = new Date();
  const [id] = await knex('crm_lead_searches').insert({ query: label, city: str(input.city, 120), country, source: 'import', auto: false, runs: 1, last_run_at: now, created_by: ctx.userId || null });
  const s = { id };
  let found = 0; let added = 0;
  for (const r of rows.slice(0, MAX_IMPORT)) { // eslint-disable-line no-restricted-syntax
    const name = str(get(r, 'name'), 190);
    if (!name) continue; // eslint-disable-line no-continue
    const phone = str(get(r, 'phone'), 40);
    const pid = get(r, 'place_id');
    const email = get(r, 'email').toLowerCase();
    const place = {
      place_id: /^(ChIJ[\w-]{10,}|0x[0-9a-f]+:0x[0-9a-f]+)$/i.test(pid) ? pid : `imp:${crypto.createHash('sha1').update(`${name.toLowerCase()}|${String(phone || '').replace(/\D/g, '').slice(-8)}`).digest('hex')}`,
      name, phone, address: str(get(r, 'address'), 255), city: str(get(r, 'city') || input.city, 120),
      country: (/^[A-Za-z]{2}$/.test(get(r, 'country')) ? get(r, 'country').toUpperCase() : country),
      website: webUrl(get(r, 'website')), email: /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,24}$/.test(email) ? email.slice(0, 190) : null,
      maps_url: webUrl(get(r, 'maps_url')), category: str(get(r, 'category'), 120),
      rating: Number.isFinite(parseFloat(get(r, 'rating'))) ? Math.min(5, parseFloat(get(r, 'rating'))) : null,
      reviews: parseInt(get(r, 'reviews').replace(/\D/g, ''), 10) || 0,
    };
    found += 1;
    if (await saveLead(s, place, { firstRun: true, now })) added += 1; // eslint-disable-line no-await-in-loop
  }
  if (!found) { await knex('crm_lead_searches').where({ id }).del(); throw E.validation({ file: 'No places with a name were found in the file.' }); }
  await audit.record({ ...ctx, businessId: null }, 'crm.leads_imported', { entityType: 'crm_lead_search', entityId: id, newValues: { label, found, added } });
  if ((await settings()).emails) await fillEmails(EMAILS_PER_RUN);
  return { id, found, added };
}

/** Reads the e-mail of leads that have a website and no e-mail yet (a few per run, four sites at a time). */
async function fillEmails(limit = EMAILS_PER_RUN) {
  const rows = await knex('crm_leads').where({ status: 'new' }).whereNotNull('website').whereNull('email').orderBy('id', 'desc').limit(limit).select('id', 'website');
  let n = 0;
  for (let i = 0; i < rows.length; i += 4) {
    await Promise.all(rows.slice(i, i + 4).map(async (r) => { // eslint-disable-line no-await-in-loop
      const email = await emailFromSite(r.website);
      await knex('crm_leads').where({ id: r.id }).update({ email: email || '' }); // '' = looked, none found
      if (email) n += 1;
    }));
  }
  return n;
}

/** The daily run of the "auto" searches (src/server.js, hourly tick: each search at most once a day). */
async function runDue(now = new Date()) {
  const sources = (await apiKey()) ? ['google', 'osm'] : ['osm'];
  const due = await knex('crm_lead_searches').where({ auto: true }).whereIn('source', sources).andWhere((w) => w.whereNull('last_run_at').orWhere('last_run_at', '<', new Date(now.getTime() - 20 * 3600_000)));
  let ran = 0;
  for (const s of due) { // eslint-disable-line no-restricted-syntax
    await run({ userId: null, businessId: null }, s.id).catch((e) => console.error('[crm-leads]', e.message)); // eslint-disable-line no-await-in-loop, no-console
    ran += 1;
  }
  return { ran };
}

// ---------------------------------------------------------------- the leads
async function list(f = {}) {
  const q = knex('crm_leads').modify((qb) => {
    if (f.search) qb.where('search_id', f.search);
    qb.where('status', STATUSES.includes(f.status) ? f.status : 'new');
    if (f.fresh === '1') qb.where('is_new_place', true);
    if (f.q) qb.andWhere((w) => w.where('name', 'like', `%${f.q}%`).orWhere('address', 'like', `%${f.q}%`));
  });
  return q.orderBy([{ column: 'is_new_place', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(300);
}

async function counts() {
  const rows = await knex('crm_leads').groupBy('status').select('status').count({ n: '*' });
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const [{ n }] = await knex('crm_leads').where({ status: 'new', is_new_place: true }).count({ n: '*' });
  return { new: by.new || 0, added: by.added || 0, ignored: by.ignored || 0, fresh: Number(n) };
}

const ids = (v) => [].concat(v || []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 300);

/** Adds the chosen places to the CRM as prospects (an existing contact with the same phone or e-mail is reused). */
async function addToCrm(ctx, idList) {
  const crm = require('./crm.service'); // eslint-disable-line global-require
  const rows = await knex('crm_leads as l').leftJoin('crm_lead_searches as s', 's.id', 'l.search_id').whereIn('l.id', ids(idList)).where('l.status', 'new').select('l.*', 's.source');
  let added = 0;
  for (const l of rows) { // eslint-disable-line no-restricted-syntax
    // The same number written another way (+962 6 555 1002, 06-5551002): the last 8 digits, spaces and signs dropped.
    const digits = String(l.phone || '').replace(/\D/g, '').slice(-8);
    const bare = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col}, ''), ' ', ''), '-', ''), '+', ''), '(', '')`;
    const same = await knex('crm_contacts').where((w) => { // eslint-disable-line no-await-in-loop
      if (l.email) w.orWhereRaw('LOWER(email) = ?', [l.email.toLowerCase()]);
      if (digits.length === 8) w.orWhereRaw(`${bare('phone')} LIKE ?`, [`%${digits}`]).orWhereRaw(`${bare('whatsapp')} LIKE ?`, [`%${digits}`]);
      if (!l.email && digits.length < 8) w.whereRaw('1 = 0');
    }).first('id');
    let contactId = same && same.id;
    if (!contactId) {
      [contactId] = await knex('crm_contacts').insert({ // eslint-disable-line no-await-in-loop
        kind: 'prospect', name: l.name, organization: l.name, phone: l.phone, email: l.email || null, country: l.country, city: l.city,
        stage: 'new', source: l.source === 'import' ? 'import' : l.source === 'osm' ? 'other' : 'google', notes: [l.address, l.website, l.maps_url].filter(Boolean).join('\n'), created_by: ctx.userId || null,
      });
      await crm.log(ctx, contactId, 'event', `${l.source === 'osm' ? 'OpenStreetMap' : l.source === 'import' ? 'CSV' : 'Google'}: ${l.name}${l.address ? ` — ${l.address}` : ''}`).catch(() => {}); // eslint-disable-line no-await-in-loop
      added += 1;
    }
    await knex('crm_leads').where({ id: l.id }).update({ status: 'added', contact_id: contactId }); // eslint-disable-line no-await-in-loop
  }
  if (rows.length) await audit.record({ ...ctx, businessId: null }, 'crm.leads_added', { newValues: { places: rows.length, contacts: added } });
  return { places: rows.length, contacts: added };
}

async function ignore(ctx, idList) {
  const n = await knex('crm_leads').whereIn('id', ids(idList)).where({ status: 'new' }).update({ status: 'ignored' });
  if (n) await audit.record({ ...ctx, businessId: null }, 'crm.leads_ignored', { newValues: { places: n } });
  return n;
}

module.exports = {
  STATUSES, SOURCES, settings, saveSettings, searches, saveSearch, setAuto, removeSearch, run, runDue, fillEmails, list, counts, addToCrm, ignore,
  importFile, parseCsv, osmQuery, emailsIn, emailFromSite, setTransport,
};
