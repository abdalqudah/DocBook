// Shared DocBook directory (/clinics): clinics that opted in (businesses.directory_listed), are active, take
// online bookings, finished setup and have at least one active doctor. Search by specialty, city, insurance,
// online consultations and text (clinic or doctor name); sort by the earliest free appointment.
//
// Next free appointment: for each active doctor, the first free slot in the next 14 days, computed with the
// scheduling engine (scheduling.computeSlots — the same pure function availableSlots() uses) from three
// batched queries per clinic (doctors, days off, bookings), then cached per clinic for 5 minutes. A request
// computes at most MAX_FRESH clinics that are not cached yet; the rest follow on later requests.
const knex = require('../../db/knex');
const cross = require('../../db/cross');
const cache = require('../../core/cache');
const { translator } = require('../../core/i18n');
const scheduling = require('../clinic/scheduling');

const types = require('../platformops/clinic-types');
const SPECIALTIES = require('../specialty/catalogue').KEYS;
const HORIZON_DAYS = 14;
const NEXT_TTL = 5 * 60_000;
const LIST_TTL = 60_000;
const MAX_FRESH = 25;
const PAGE_SIZE = 24;

// ---------------------------------------------------------------- text normalisation
/** Case/space/diacritics-insensitive key (Arabic: tashkeel removed, alef/yaa/taa-marbuta forms unified). */
function norm(v) {
  return String(v || '').normalize('NFKC').toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '') // tashkeel + tatweel
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[\s‌‏‎]+/g, ' ')
    .trim();
}

const labels = { ar: translator('ar'), en: translator('en') };
/** Specialty key of a clinic's stored specialty (a key, or free text matching a label in either language). */
function specialtyKey(raw) {
  if (!raw) return null;
  const v = String(raw).trim();
  if (types.valid(v)) return v;
  const n = norm(v);
  return types.keys().find((k) => norm(labels.ar(`specialties.${k}`)) === n || norm(labels.en(`specialties.${k}`)) === n) || null;
}

// ---------------------------------------------------------------- listed clinics
// A listed clinic needs an active doctor; doctors are in each clinic's own database (src/db/tenant.js), so that part is
// checked after reading the clinics.
const eligible = () => knex('businesses as b')
  .where({ 'b.status': 'active', 'b.booking_enabled': true, 'b.directory_listed': true }).whereNotNull('b.onboarding_completed_at');

/** Every listed clinic with its active doctors and insurance names (cached for a minute). */
function listed() {
  return cache.remember('discover:list', async () => {
    const clinics = await eligible().orderBy('b.id').limit(2000)
      .select('b.id', 'b.slug', 'b.name', 'b.name_en', 'b.specialty', 'b.city', 'b.timezone', 'b.logo_mime', 'b.logo_version', 'b.about', 'b.about_en',
        'b.address', 'b.phone', 'b.online_enabled', 'b.updated_at');
    if (!clinics.length) return [];
    const allIds = clinics.map((c) => c.id);
    const docsAll = await cross.gatherFor(allIds, (list) => knex('doctors').whereIn('business_id', list).where('is_active', true).where('show_on_site', true).orderBy([{ column: 'sort_order' }, { column: 'full_name' }])
      .select('id', 'business_id', 'full_name', 'full_name_en', 'specialization', 'specialization_en', 'online_enabled'));
    const withDoctors = new Set(docsAll.map((d) => d.business_id));
    clinics.splice(0, clinics.length, ...clinics.filter((c) => withDoctors.has(c.id)));
    if (!clinics.length) return [];
    const ids = clinics.map((c) => c.id);
    // Verified patient reviews (published only), when the reviews feature is installed.
    const hasReviews = await knex.schema.hasTable('reviews');
    const [docs, ins, revs] = await Promise.all([
      docsAll,
      cross.gatherFor(ids, (list) => knex('insurance_providers').whereIn('business_id', list).where('is_active', true).select('business_id', 'name')),
      hasReviews ? knex('reviews').whereIn('business_id', ids).where('status', 'published').groupBy('business_id')
        .select('business_id', knex.raw('AVG(rating) as avg'), knex.raw('COUNT(*) as n')) : [],
    ]);
    return clinics.map((c) => {
      const doctors = docs.filter((d) => d.business_id === c.id);
      return {
        ...c,
        specialtyKey: specialtyKey(c.specialty),
        cityKey: norm(c.city),
        insurers: [...new Set(ins.filter((i) => i.business_id === c.id).map((i) => String(i.name).trim()).filter(Boolean))],
        doctors,
        online: Boolean(c.online_enabled) && doctors.some((d) => d.online_enabled),
        rating: (() => { const r = revs.find((x) => x.business_id === c.id); return r && Number(r.n) ? { avg: Math.round(Number(r.avg) * 10) / 10, count: Number(r.n) } : null; })(),
        search: norm([c.name, c.name_en, ...doctors.flatMap((d) => [d.full_name, d.full_name_en])].filter(Boolean).join(' | ')),
      };
    });
  }, LIST_TTL);
}

/** Forget cached directory data (after a clinic changes its listing). */
function forget(clinicId) {
  cache.forgetPrefix('discover:list');
  if (clinicId) cache.forgetPrefix(`discover:next:${clinicId}`);
}

// ---------------------------------------------------------------- next free appointment
const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * Earliest free slot among the clinic's active doctors in the next `days` days (pure: data passed in).
 * @param {{ doctors, daysOff:[{doctor_id,off_date}], booked:[{doctor_id,date,time,duration}], today, nowMinutes, days }} o
 * @returns {{ date, time, doctorId } | null}
 */
function earliestSlot({ doctors, daysOff = [], booked = [], today, nowMinutes = 0, days = HORIZON_DAYS }) {
  for (let i = 0; i < days; i += 1) {
    const date = addDays(today, i);
    let best = null;
    for (const d of doctors) {
      const wh = typeof d.working_hours === 'string' ? JSON.parse(d.working_hours) : d.working_hours;
      const slots = scheduling.computeSlots({
        workingHours: wh, slotStep: d.slot_duration_minutes, duration: d.slot_duration_minutes, date, today, nowMinutes,
        dayOff: daysOff.some((o) => o.doctor_id === d.id && o.off_date === date),
        booked: booked.filter((b) => b.doctor_id === d.id && b.date === date),
      });
      if (slots.length && (!best || slots[0] < best.time)) best = { date, time: slots[0], doctorId: d.id };
    }
    if (best) return best;
  }
  return null;
}

/** Reads the clinic's schedule data for the next 14 days and finds the earliest free slot. */
async function computeNext(clinic, at = new Date()) {
  return require('../../db/tenant').inClinic(clinic.id, () => computeNextHere(clinic, at)); // eslint-disable-line global-require -- the clinic's own database
}
async function computeNextHere(clinic, at) {
  const { date: today, minutes: nowMinutes } = scheduling.clinicNow(clinic.timezone || 'UTC', at);
  const last = addDays(today, HORIZON_DAYS - 1);
  const doctors = await knex('doctors').where({ business_id: clinic.id, is_active: true }).select('id', 'working_hours', 'slot_duration_minutes');
  if (!doctors.length) return null;
  const ids = doctors.map((d) => d.id);
  const [daysOff, booked] = await Promise.all([
    knex('doctor_days_off').where({ business_id: clinic.id }).whereIn('doctor_id', ids).whereBetween('off_date', [today, last]).select('doctor_id', 'off_date'),
    knex('appointments as a').leftJoin('services as s', 's.id', 'a.service_id').leftJoin('doctors as d', 'd.id', 'a.doctor_id')
      .whereIn('a.doctor_id', ids).whereBetween('a.appointment_date', [today, last]).whereNot('a.status', 'cancelled')
      .select('a.doctor_id', 'a.appointment_date as date', 'a.appointment_time as time', knex.raw('COALESCE(a.duration_minutes, s.duration_minutes, d.slot_duration_minutes, 30) as duration')),
  ]);
  return earliestSlot({ doctors, daysOff: daysOff.map((o) => ({ ...o, off_date: String(o.off_date).slice(0, 10) })), booked, today, nowMinutes });
}

const nextKey = (id) => `discover:next:${id}`;
/** Cached next free slot: { slot } (slot may be null), or undefined when not computed yet. */
const cachedNext = (id) => cache.get(nextKey(id));

/** Fills `next` on each clinic from the cache, computing at most `max` missing ones (earliest first in the list). */
async function withNext(clinics, max = MAX_FRESH) {
  let fresh = 0;
  for (const c of clinics) {
    let hit = cachedNext(c.id);
    if (hit === undefined && fresh < max) {
      fresh += 1;
      hit = cache.set(nextKey(c.id), { slot: await computeNext(c) }, NEXT_TTL); // eslint-disable-line no-await-in-loop
    }
    c.next = hit ? hit.slot : undefined; // undefined = not computed yet
    c.nextKnown = hit !== undefined;
  }
  return clinics;
}

// ---------------------------------------------------------------- search
/** Parses and cleans the filters of a directory request. */
function filtersFrom(query = {}, preset = {}) {
  const s = String(preset.specialty || query.specialty || '');
  const sort = query.sort === 'name' ? 'name' : 'soonest';
  const page = Math.max(1, Math.min(200, parseInt(query.page, 10) || 1));
  return {
    q: String(query.q || '').trim().slice(0, 80),
    specialty: types.valid(s) ? s : '',
    city: norm(query.city).slice(0, 80),
    insurance: norm(query.insurance).slice(0, 120),
    online: query.online === '1',
    sort, page,
  };
}

const matches = (c, f) => (!f.specialty || c.specialtyKey === f.specialty)
  && (!f.city || c.cityKey === f.city)
  && (!f.insurance || c.insurers.some((n) => norm(n) === f.insurance))
  && (!f.online || c.online)
  && (!f.q || norm(f.q).split(' ').every((w) => c.search.includes(w)));

/** Pick-lists built from the listed clinics: cities, insurers and specialties that exist. */
function facets(all) {
  const count = (items) => {
    const m = new Map();
    items.forEach(([key, label]) => {
      if (!key) return;
      const e = m.get(key) || { key, labels: new Map(), n: 0 };
      e.n += 1; e.labels.set(label, (e.labels.get(label) || 0) + 1);
      m.set(key, e);
    });
    // Display the most common spelling of each normalised value.
    return [...m.values()].map((e) => ({ key: e.key, label: [...e.labels.entries()].sort((a, b) => b[1] - a[1])[0][0], n: e.n }))
      .sort((a, b) => a.label.localeCompare(b.label));
  };
  return {
    cities: count(all.map((c) => [c.cityKey, String(c.city || '').trim().replace(/\s+/g, ' ')])),
    insurers: count(all.flatMap((c) => c.insurers.map((n) => [norm(n), n]))),
    specialties: types.keys().filter((k) => all.some((c) => c.specialtyKey === k)),
    online: all.some((c) => c.online),
  };
}

const compareNext = (a, b) => {
  const ka = a.next ? `${a.next.date} ${a.next.time}` : (a.nextKnown ? '~' : '~~');
  const kb = b.next ? `${b.next.date} ${b.next.time}` : (b.nextKnown ? '~' : '~~');
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/** Search the directory. Returns { rows, total, page, pages, facets }. */
async function search(filters, locale = 'ar') {
  const all = await listed();
  const nameOf = (c) => (locale === 'en' && c.name_en) || c.name;
  let rows = all.filter((c) => matches(c, filters)).map((c) => ({ ...c }));
  if (filters.sort === 'soonest') {
    await withNext(rows);
    rows.sort((a, b) => compareNext(a, b) || nameOf(a).localeCompare(nameOf(b)));
  } else rows.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  rows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  if (filters.sort !== 'soonest') await withNext(rows);
  return { rows, total, page, pages, facets: facets(all) };
}

/** Sitemap entries: the directory and one page per specialty with listed clinics. */
async function sitemapUrls() {
  const all = await listed();
  if (!all.length) return [];
  const last = all.reduce((m, c) => (c.updated_at && (!m || c.updated_at > m) ? c.updated_at : m), null);
  return [{ loc: '/clinics', lastmod: last }, ...facets(all).specialties.map((k) => ({ loc: `/clinics/${k}`, lastmod: last }))];
}

/** Why a clinic is (not) shown in the directory — for its settings page. */
async function readiness(businessId) {
  const [b, [{ n }]] = await Promise.all([
    knex('businesses').where({ id: businessId }).first('status', 'booking_enabled', 'directory_listed', 'onboarding_completed_at', 'slug', 'city', 'specialty'),
    require('../../db/tenant').inClinic(businessId, () => knex('doctors').where({ business_id: businessId, is_active: true }).count({ n: '*' })), // eslint-disable-line global-require
  ]);
  const checks = { booking: Boolean(b.booking_enabled), doctors: Number(n) > 0, slug: Boolean(b.slug), setup: Boolean(b.onboarding_completed_at), city: Boolean(b.city), specialty: Boolean(specialtyKey(b.specialty)) };
  return { listed: Boolean(b.directory_listed), visible: Boolean(b.directory_listed) && b.status === 'active' && checks.booking && checks.doctors && checks.slug && checks.setup, checks };
}

module.exports = {
  SPECIALTIES, HORIZON_DAYS, NEXT_TTL, MAX_FRESH, PAGE_SIZE, norm, specialtyKey, listed, forget, earliestSlot, computeNext, withNext, cachedNext,
  filtersFrom, matches, facets, search, sitemapUrls, readiness, addDays,
};
