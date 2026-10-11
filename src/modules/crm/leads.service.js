// CRM → find clinics on Google. A saved search ("dental clinic", a city, a country) asks the Google Places API (Text
// Search, with the platform's own API key) for the places it knows — name, address, phone, website, rating — and
// reads the public e-mail address from each clinic's website. Searches marked "auto" run again every day: a place that
// was not in the earlier runs is flagged as new on Google (often a clinic that just opened) and the admin is notified.
// Places are leads until the admin adds them to the CRM (one contact each, matched to an existing one by phone or
// e-mail) or ignores them.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const outbound = require('../../core/http');
const { E } = require('../../core/errors');

const KEY = 'crm_google';
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
  const [id] = await knex('crm_lead_searches').insert({ query, city: str(input.city, 120), country, auto: input.auto === '1' || input.auto === 'on', created_by: ctx.userId || null });
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

// ---------------------------------------------------------------- running a search
async function run(ctx, searchId, { locale = 'ar' } = {}) {
  const s = await knex('crm_lead_searches').where({ id: searchId }).first();
  if (!s) throw E.notFound('Search');
  const key = await apiKey();
  if (!key) throw E.validation({ google: 'Add the Google Maps API key first.' });
  const firstRun = !s.runs;
  const now = new Date();
  let found = 0; let added = 0; let fresh = 0;
  try {
    const body = { textQuery: [s.query, s.city].filter(Boolean).join(' '), languageCode: locale === 'en' ? 'en' : 'ar', pageSize: 20 };
    if (s.country) body.regionCode = s.country;
    let token = null;
    for (let i = 0; i < PAGES; i += 1) {
      const page = await searchPage(key, token ? { ...body, pageToken: token } : body); // eslint-disable-line no-await-in-loop
      for (const p of page.places) { // eslint-disable-line no-restricted-syntax
        if (!p.id || p.businessStatus === 'CLOSED_PERMANENTLY') continue; // eslint-disable-line no-continue
        found += 1;
        const row = {
          name: str(p.displayName && p.displayName.text, 190) || '—', address: str(p.formattedAddress, 255),
          city: str(component(p, 'locality', false) || component(p, 'administrative_area_level_1', false), 120),
          country: (component(p, 'country') || s.country || '').toUpperCase().slice(0, 2) || null,
          phone: str(p.internationalPhoneNumber || p.nationalPhoneNumber, 40), website: webUrl(p.websiteUri), maps_url: webUrl(p.googleMapsUri),
          lat: p.location ? p.location.latitude : null, lng: p.location ? p.location.longitude : null,
          rating: p.rating === undefined ? null : p.rating, reviews: p.userRatingCount === undefined ? 0 : p.userRatingCount, last_seen_at: now,
        };
        const known = await knex('crm_leads').where({ place_id: p.id }).first('id'); // eslint-disable-line no-await-in-loop
        if (known) { await knex('crm_leads').where({ id: known.id }).update(row); continue; } // eslint-disable-line no-await-in-loop, no-continue
        await knex('crm_leads').insert({ ...row, place_id: p.id, search_id: s.id, is_new_place: !firstRun, first_seen_at: now }); // eslint-disable-line no-await-in-loop
        added += 1; if (!firstRun) fresh += 1;
      }
      token = page.next;
      if (!token) break;
    }
    await knex('crm_lead_searches').where({ id: s.id }).update({ runs: s.runs + 1, last_run_at: now, last_error: null, updated_at: now });
  } catch (e) {
    await knex('crm_lead_searches').where({ id: s.id }).update({ last_run_at: now, last_error: String((e.details && e.details.google) || e.message).slice(0, 250) });
    throw e;
  }
  if ((await settings()).emails) await fillEmails(EMAILS_PER_RUN);
  if (fresh) {
    const pnotify = require('../platformnotify/notify.service'); // eslint-disable-line global-require
    await pnotify.admin('crm_new_places', { n: fresh, query: [s.query, s.city].filter(Boolean).join(' — ') }, { link: `/admin/crm/finder?search=${s.id}&fresh=1`, severity: 'success' });
  }
  return { found, added, fresh };
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
  if (!(await apiKey())) return { ran: 0 };
  const due = await knex('crm_lead_searches').where({ auto: true }).andWhere((w) => w.whereNull('last_run_at').orWhere('last_run_at', '<', new Date(now.getTime() - 20 * 3600_000)));
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
  const rows = await knex('crm_leads').whereIn('id', ids(idList)).where({ status: 'new' });
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
        stage: 'new', source: 'google', notes: [l.address, l.website, l.maps_url].filter(Boolean).join('\n'), created_by: ctx.userId || null,
      });
      await crm.log(ctx, contactId, 'event', `Google: ${l.name}${l.address ? ` — ${l.address}` : ''}`).catch(() => {}); // eslint-disable-line no-await-in-loop
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
  STATUSES, settings, saveSettings, searches, saveSearch, setAuto, removeSearch, run, runDue, fillEmails, list, counts, addToCrm, ignore,
  emailsIn, emailFromSite, setTransport,
};
