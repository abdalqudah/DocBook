// Public side of "discover": the shared clinic directory (/clinics, /clinics/<specialty>), the booking widget
// script (/widget.js) and the confirmation page of a booking made inside the widget (embed mode, no session).
// Mounted in src/routes/web.js BEFORE the clinic pages (/<slug>…). "clinics" is reserved in businesses.RESERVED.
const fs = require('fs');
const path = require('path');
const express = require('express');
const knex = require('../../db/knex');
const config = require('../../config');
const brand = require('../../config/brand');
const fmtCore = require('../../core/format');
const { wrap } = require('../../routes/helpers');
const scheduling = require('../clinic/scheduling');
const seo = require('../site/seo.service');
const dir = require('./directory.service');

const router = express.Router();
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- widget script
const WIDGET_FILE = path.join(__dirname, '..', '..', '..', 'public', 'js', 'docbook-widget.js');
let widgetSrc = null;
router.get('/widget.js', (req, res) => {
  if (widgetSrc === null || !config.isProd) {
    const c = brand.colors.light;
    widgetSrc = fs.readFileSync(WIDGET_FILE, 'utf8').replace(/__DB_PRIMARY_INK__/g, c.primaryInk).replace(/__DB_PRIMARY__/g, c.primary);
  }
  res.set({
    'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600',
    'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff',
  });
  res.send(widgetSrc);
});

// ---------------------------------------------------------------- directory
/** "Tomorrow 10:30" style label of a next free slot, relative to the clinic's today. */
function nextLabel(req, c) {
  if (c.next === undefined) return { text: req.t('directory.next_unknown'), known: false };
  if (!c.next) return { text: req.t('directory.next_none', { n: dir.HORIZON_DAYS }), known: true, none: true };
  const today = scheduling.clinicNow(c.timezone || 'UTC').date;
  const time = c.next.time;
  if (c.next.date === today) return { text: req.t('directory.next_today', { time }), known: true };
  if (c.next.date === dir.addDays(today, 1)) return { text: req.t('directory.next_tomorrow', { time }), known: true };
  return { text: req.t('directory.next_on', { date: fmtCore.formatDate(c.next.date, req.locale, { weekday: 'short', day: 'numeric', month: 'short' }), time }), known: true };
}

function card(req, c) {
  const en = req.locale === 'en';
  const name = (en && c.name_en) || c.name;
  const other = en ? (c.name_en ? c.name : null) : c.name_en;
  const spec = c.specialtyKey ? req.t(`specialties.${c.specialtyKey}`) : (c.specialty || '');
  const docNames = c.doctors.map((d) => (en && d.full_name_en) || d.full_name);
  return {
    id: c.id, slug: c.slug, name, other: other && other !== name ? other : null, specialty: spec, city: c.city || '', online: c.online,
    logo: c.logo_mime ? `/${c.slug}/logo?v=${c.logo_version}` : null, doctors: docNames, insurers: c.insurers, rating: c.rating,
    next: nextLabel(req, c), bookHref: `/${c.slug}/book?src=directory`, pageHref: `/${c.slug}?src=directory`,
  };
}

async function directory(req, res, preset = {}) {
  const f = dir.filtersFrom(req.query, preset);
  const result = await dir.search(f, req.locale);
  const cityLabel = f.city ? (result.facets.cities.find((c) => c.key === f.city) || {}).label : null;
  const specLabel = f.specialty ? req.t(`specialties.${f.specialty}`) : null;
  // Titles for the specialty/city pages; free-text searches and other filters are not indexed.
  let heading = req.t('directory.title');
  if (specLabel && cityLabel) heading = req.t('directory.title_specialty_city', { specialty: specLabel, city: cityLabel });
  else if (specLabel) heading = req.t('directory.title_specialty', { specialty: specLabel });
  else if (cityLabel) heading = req.t('directory.title_city', { city: cityLabel });

  const s = await seo.get();
  const base = seo.baseUrl(req, s);
  const site = seo.L(s.site_name, req.locale) || brand.name;
  const canonicalPath = preset.specialty ? `/clinics/${preset.specialty}` : '/clinics';
  const filtered = Boolean(f.q || f.city || f.insurance || f.online || f.sort !== 'soonest' || f.page > 1 || (f.specialty && !preset.specialty));
  const description = specLabel ? req.t('directory.meta_specialty', { specialty: specLabel, brand: site }) : req.t('directory.meta_description', { n: result.total, brand: site });
  const cards = result.rows.map((c) => card(req, c));
  const ld = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: req.t('directory.ld_name', { brand: site }), url: `${base}${canonicalPath}`, numberOfItems: result.total,
    itemListElement: cards.map((c, i) => ({
      '@type': 'ListItem', position: (result.page - 1) * dir.PAGE_SIZE + i + 1, url: `${base}/${c.slug}`,
      item: { '@type': 'MedicalClinic', '@id': `${base}/${c.slug}#clinic`, name: c.name, url: `${base}/${c.slug}`,
        ...(c.city ? { address: { '@type': 'PostalAddress', addressLocality: c.city } } : {}), ...(c.specialty ? { keywords: c.specialty } : {}),
        ...(c.rating ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: c.rating.avg, reviewCount: c.rating.count, bestRating: 5, worstRating: 1 } } : {}) },
    })),
  };
  const url = `${base}${canonicalPath}`;
  const tags = [
    `<meta name="description" content="${esc(description)}">`,
    ...(!s.index_clinics || filtered || !result.total ? ['<meta name="robots" content="noindex, follow">'] : []),
    `<link rel="canonical" href="${esc(`${url}?lang=${req.locale}`)}">`,
    ...['ar', 'en'].map((lc) => `<link rel="alternate" hreflang="${lc}" href="${esc(`${url}?lang=${lc}`)}">`),
    `<link rel="alternate" hreflang="x-default" href="${esc(url)}">`,
    '<meta property="og:type" content="website">', `<meta property="og:site_name" content="${esc(site)}">`,
    `<meta property="og:title" content="${esc(heading)}">`, `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(`${url}?lang=${req.locale}`)}">`, '<meta name="twitter:card" content="summary">',
    `<script type="application/ld+json">${seo.ldJson(ld)}</script>`,
  ];
  res.page('pages/discover/directory', {
    layout: 'public', title: heading, seoHead: { title: `${heading} · ${site}`, html: tags.join('\n') },
    f, preset, heading, cards, facets: result.facets, total: result.total, allCount: (await dir.listed()).length,
    meta: { page: result.page, pages: result.pages, total: result.total, perPage: dir.PAGE_SIZE },
    specLabel, cityLabel, filtered, pageStyles: ['/css/discover.css'],
  });
}

router.get('/clinics', wrap((req, res) => directory(req, res)));
router.get('/clinics/:specialty', wrap((req, res, next) => (require('../platformops/clinic-types').valid(req.params.specialty) ? directory(req, res, { specialty: req.params.specialty }) : next())));

// ---------------------------------------------------------------- widget booking confirmation (embed mode)
router.get('/:slug/book/done', wrap(async (req, res, next) => {
  if (!req.embedDone) return next();
  const { clinicId, apptId } = req.embedDone;
  const { loadClinic, clinicStyles } = require('../site/portal.web'); // eslint-disable-line global-require
  const clinic = await loadClinic(req);
  if (!clinic || clinic.id !== clinicId) return next();
  const a = await knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
    .where({ 'a.id': apptId, 'a.business_id': clinic.id })
    .first('a.id', 'a.appointment_date', 'a.appointment_time', 'a.status', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 's.name as service_name', 's.name_en as service_name_en');
  if (!a) return res.redirect(`/${clinic.slug}/book?embed=1`);
  const en = req.locale === 'en';
  const appt = { ...a, doctor: (en && a.doctor_name_en) || a.doctor_name, service: (en && a.service_name_en) || a.service_name };
  return res.page('pages/discover/embed-done', { layout: 'public', title: req.t('booking.done_title'), clinic, appt, hideBookCta: true, noindex: true, pageStyles: [...clinicStyles(clinic), '/css/discover.css'] });
}));

module.exports = router;
