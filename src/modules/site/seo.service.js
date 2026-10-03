// Search and AI visibility of DocBook's public pages, managed by the platform admin (Admin → Search & AI):
//  • SEO — landing title/description per language, share (Open Graph) image from the media library,
//          canonical base address, language alternates, search-console verification, sitemap.xml, robots.txt.
//  • AEO — structured data (JSON-LD): Organization, WebSite and SoftwareApplication for DocBook and FAQPage
//          from the landing FAQ on "/", and a MedicalClinic with its doctors (Physician) on each clinic page.
//  • GEO — /llms.txt, a factual plain-text summary for AI assistants (generated, or written by the admin),
//          and per-crawler switches for AI bots in robots.txt.
// Plus Admin → Social & tracking: social links (footer + Organization sameAs) and measurement pixels.
// Pixels load ONLY on public marketing pages (the landing page and the cookie-preferences page), ONLY after the
// visitor accepts, and never on clinic pages, booking, sign-in, /app or /admin. The vendor hosts are added to
// the Content-Security-Policy of those responses only (applyPixelCsp).
// Stored as JSON in platform_settings ("site_seo", "site_marketing"); every change is audited (platform scope).
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const config = require('../../config');
const brand = require('../../config/brand');
const { E } = require('../../core/errors');
const content = require('./content.service');

const SEO_KEY = 'site_seo';
const MKT_KEY = 'site_marketing';
const CONSENT_COOKIE = 'db_consent';

const AI_BOTS = {
  gptbot: 'GPTBot', oai_searchbot: 'OAI-SearchBot', chatgpt_user: 'ChatGPT-User', claudebot: 'ClaudeBot', claude_searchbot: 'Claude-SearchBot',
  perplexitybot: 'PerplexityBot', google_extended: 'Google-Extended', applebot_extended: 'Applebot-Extended', ccbot: 'CCBot',
};
// Never indexed: signed-in areas, one-time links, staff sign-in and the booking steps after the form.
const PRIVATE_PATHS = ['/app', '/admin', '/api', '/reset', '/invite', '/verify-email', '/password', '/workspaces', '/preferences/', '/*/login', '/*/book/'];

// Social profiles: https links on the platform's own domains only.
const SOCIAL = {
  x: { hosts: ['x.com', 'twitter.com'], icon: 'twitter' },
  instagram: { hosts: ['instagram.com'], icon: 'instagram' },
  facebook: { hosts: ['facebook.com', 'fb.com'], icon: 'facebook' },
  linkedin: { hosts: ['linkedin.com'], icon: 'linkedin' },
  youtube: { hosts: ['youtube.com', 'youtu.be'], icon: 'youtube' },
  tiktok: { hosts: ['tiktok.com'], icon: 'music' },
  snapchat: { hosts: ['snapchat.com'], icon: 'ghost' },
  whatsapp: { hosts: ['wa.me', 'whatsapp.com'], icon: 'message-circle' },
  telegram: { hosts: ['t.me', 'telegram.me'], icon: 'send' },
};

// Pixel ID formats and the hosts each vendor needs (script, connect, img) on the pages that load it.
const PIXELS = {
  ga4: { name: 'Google Analytics 4', re: /^G-[A-Z0-9]{6,12}$/, script: ['https://www.googletagmanager.com'], connect: ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://www.googletagmanager.com'], img: ['https://*.google-analytics.com', 'https://www.googletagmanager.com'] },
  gtm: { name: 'Google Tag Manager', re: /^GTM-[A-Z0-9]{5,10}$/, script: ['https://www.googletagmanager.com'], connect: ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://www.googletagmanager.com'], img: ['https://www.googletagmanager.com'] },
  meta: { name: 'Meta Pixel', re: /^\d{10,20}$/, script: ['https://connect.facebook.net'], connect: ['https://www.facebook.com', 'https://connect.facebook.net'], img: ['https://www.facebook.com'] },
  tiktok: { name: 'TikTok Pixel', re: /^[A-Z0-9]{15,25}$/, script: ['https://analytics.tiktok.com'], connect: ['https://analytics.tiktok.com'], img: ['https://analytics.tiktok.com'] },
  snap: { name: 'Snap Pixel', re: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, script: ['https://sc-static.net'], connect: ['https://tr.snapchat.com', 'https://tr-shadow.snapchat.com'], img: ['https://tr.snapchat.com'] },
  linkedin: { name: 'LinkedIn Insight Tag', re: /^\d{5,10}$/, script: ['https://snap.licdn.com'], connect: ['https://px.ads.linkedin.com'], img: ['https://px.ads.linkedin.com'] },
  x: { name: 'X Pixel', re: /^[a-z0-9]{5,10}$/, script: ['https://static.ads-twitter.com'], connect: ['https://analytics.twitter.com', 'https://static.ads-twitter.com'], img: ['https://t.co', 'https://analytics.twitter.com'] },
};

const clip = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);
const oneLine = (v, n) => clip(v, n).replace(/\s+/g, ' ');
const bi = (body, key, n, line = true) => ({ ar: (line ? oneLine : clip)(body[`${key}_ar`], n), en: (line ? oneLine : clip)(body[`${key}_en`], n) });
const L = (v, locale) => (v && typeof v === 'object' ? (v[locale] || v[locale === 'ar' ? 'en' : 'ar'] || '') : (v || ''));
const strip = (v) => String(v || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JSON for a <script type="application/ld+json"> block (cannot close the tag or start markup). */
const ldJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

async function read(key) {
  const row = await knex('platform_settings').where({ key }).first('value');
  if (!row) return {};
  try { return typeof row.value === 'string' ? JSON.parse(row.value) : row.value || {}; } catch { return {}; }
}
async function write(key, value) {
  const json = JSON.stringify(value);
  const exists = await knex('platform_settings').where({ key }).first('key');
  if (exists) await knex('platform_settings').where({ key }).update({ value: json, updated_at: new Date() });
  else await knex('platform_settings').insert({ key, value: json });
  cache.forgetPrefix('site:');
}

// ---------------------------------------------------------------- settings
async function get() {
  return cache.remember('site:seo', async () => {
    const v = await read(SEO_KEY);
    return {
      base_url: v.base_url || '',
      site_name: v.site_name || { ar: brand.name, en: brand.name },
      title: v.title || { ar: '', en: '' },
      description: v.description || { ar: '', en: '' },
      og_image: v.og_image || '',
      x_handle: v.x_handle || '',
      verify: { google: '', bing: '', ...(v.verify || {}) },
      org: { legal_name: '', email: '', phone: '', city: '', country: '', ...(v.org || {}) },
      index_home: v.index_home !== false,
      index_clinics: v.index_clinics !== false,
      bots: { ...Object.fromEntries(Object.keys(AI_BOTS).map((k) => [k, true])), ...(v.bots || {}) },
      disallow: Array.isArray(v.disallow) ? v.disallow : [],
      llms: v.llms || '',
      updated_at: v.updated_at || null,
    };
  }, 60_000);
}

function cleanBase(raw) {
  const s = clip(raw, 200).replace(/\/+$/, '');
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return null; }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (local && u.protocol === 'http:'))) return null;
  if (u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
  return `${u.protocol}//${u.host}`;
}

async function save(ctx, body) {
  const errors = {};
  const base = cleanBase(body.base_url);
  if (base === null) errors.base_url = 'growth_err.base_url';
  const org = {
    legal_name: oneLine(body.o_legal_name, 150), email: oneLine(body.o_email, 150).toLowerCase(), phone: oneLine(body.o_phone, 40),
    city: oneLine(body.o_city, 80), country: oneLine(body.o_country, 2).toUpperCase(),
  };
  if (org.email && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(org.email)) errors.o_email = 'growth_err.email';
  if (org.phone && !/^\+?[0-9 ()-]{6,30}$/.test(org.phone)) errors.o_phone = 'growth_err.phone';
  if (org.country && !/^[A-Z]{2}$/.test(org.country)) errors.o_country = 'growth_err.country';
  const verify = { google: oneLine(body.v_google, 100), bing: oneLine(body.v_bing, 100) };
  for (const k of Object.keys(verify)) if (verify[k] && !/^[A-Za-z0-9_-]{6,100}$/.test(verify[k])) errors[`v_${k}`] = 'growth_err.token';
  const xHandle = oneLine(body.x_handle, 40).replace(/^@/, '');
  if (xHandle && !/^[A-Za-z0-9_]{1,15}$/.test(xHandle)) errors.x_handle = 'growth_err.handle';
  const disallow = clip(body.disallow, 2000).split('\n').map((l) => l.trim()).filter(Boolean);
  if (disallow.length > 30 || disallow.some((p) => !/^\/[A-Za-z0-9/_.*$?=&-]{0,120}$/.test(p))) errors.disallow = 'growth_err.paths';
  const ogImage = /^\d{1,10}$/.test(String(body.og_image || '')) ? String(body.og_image) : '';
  if (ogImage && !(await knex('site_media').where({ id: Number(ogImage) }).first('id'))) errors.og_image = 'growth_err.media';
  if (Object.keys(errors).length) throw E.validation(errors);

  const before = await get();
  const value = {
    base_url: base || '',
    site_name: bi(body, 'site_name', 80), title: bi(body, 'title', 120), description: bi(body, 'description', 320),
    og_image: ogImage, x_handle: xHandle, verify, org,
    index_home: body.index_home === '1', index_clinics: body.index_clinics === '1',
    bots: Object.fromEntries(Object.keys(AI_BOTS).map((k) => [k, body[`b_${k}`] === '1'])),
    disallow, llms: clip(body.llms, 20000),
    updated_at: new Date().toISOString(),
  };
  await write(SEO_KEY, value);
  const changed = Object.keys(value).filter((k) => k !== 'updated_at' && JSON.stringify(value[k]) !== JSON.stringify(before[k]));
  await audit.record({ ...ctx, businessId: null }, 'platform.seo_updated', { entityType: 'site', entityId: 'seo', newValues: { changed: changed.join(', ') || '—' } });
}

async function marketing() {
  return cache.remember('site:marketing', async () => {
    const v = await read(MKT_KEY);
    return { social: v.social || {}, pixels: v.pixels || {}, updated_at: v.updated_at || null };
  }, 60_000);
}

function validSocial(key, v) {
  let u;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || /[\s<>"'`]/.test(v)) return false;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  return SOCIAL[key].hosts.includes(host);
}

async function saveMarketing(ctx, body) {
  const errors = {};
  const social = {};
  for (const k of Object.keys(SOCIAL)) {
    const v = clip(body[`social_${k}`], 300);
    if (!v) continue; // eslint-disable-line no-continue
    if (!validSocial(k, v)) errors[`social_${k}`] = 'growth_err.social';
    else social[k] = v;
  }
  const pixels = {};
  for (const [k, def] of Object.entries(PIXELS)) {
    const v = clip(body[`pixel_${k}`], 60);
    if (!v) continue; // eslint-disable-line no-continue
    if (!def.re.test(v)) errors[`pixel_${k}`] = 'growth_err.pixel';
    else pixels[k] = v;
  }
  if (Object.keys(errors).length) throw E.validation(errors);
  const before = await marketing();
  await write(MKT_KEY, { social, pixels, updated_at: new Date().toISOString() });
  await audit.record({ ...ctx, businessId: null }, 'platform.marketing_updated', {
    entityType: 'site', entityId: 'marketing',
    oldValues: { pixels: Object.keys(before.pixels).join(', ') || '—', social: Object.keys(before.social).join(', ') || '—' },
    newValues: { pixels: Object.keys(pixels).join(', ') || '—', social: Object.keys(social).join(', ') || '—' },
  });
}

const hasPixels = (m) => Object.values((m && m.pixels) || {}).some(Boolean);
/** The visitor's cookie choice: for the platform's pages, or for one clinic's website (scope 'c<id>'). */
const consentCookie = (scope) => (scope && /^c\d{1,10}$/.test(scope) ? `${CONSENT_COOKIE}_${scope}` : CONSENT_COOKIE);
const consentOf = (req, scope = null) => { const v = req.cookies && req.cookies[consentCookie(scope)]; return ['yes', 'no'].includes(v) ? v : ''; };

/**
 * Adds the enabled vendors' hosts to THIS response's Content-Security-Policy (script/connect/img).
 * Only called by the public marketing pages after consent; every other page keeps the strict default.
 */
function applyPixelCsp(res, ids) {
  const header = res.getHeader('Content-Security-Policy');
  if (!header) return;
  const add = { 'script-src': new Set(), 'connect-src': new Set(), 'img-src': new Set() };
  for (const k of Object.keys(ids || {})) {
    const def = PIXELS[k];
    if (!def) continue; // eslint-disable-line no-continue
    def.script.forEach((h) => add['script-src'].add(h));
    def.connect.forEach((h) => add['connect-src'].add(h));
    def.img.forEach((h) => add['img-src'].add(h));
  }
  const parts = String(header).split(';').map((p) => p.trim()).filter(Boolean);
  const seen = new Set();
  const out = parts.map((p) => {
    const name = p.split(/\s+/)[0];
    seen.add(name);
    return add[name] && add[name].size ? `${p} ${[...add[name]].join(' ')}` : p;
  });
  for (const [name, hosts] of Object.entries(add)) if (!seen.has(name) && hosts.size) out.push(`${name} 'self' ${[...hosts].join(' ')}`);
  res.setHeader('Content-Security-Policy', out.join(';'));
}

// ---------------------------------------------------------------- addresses
function baseUrl(req, s) {
  if (s && s.base_url) return s.base_url;
  if (process.env.APP_URL) return config.appUrl.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** Clinics whose public page is listed in the sitemap (active, set up, taking online bookings). */
async function listedClinics(limit = 5000) {
  return knex('businesses').where({ status: 'active', booking_enabled: true }).whereNotNull('onboarding_completed_at')
    .orderBy('id').limit(limit).select('id', 'slug', 'name', 'name_en', 'city', 'specialty', 'phone', 'address', 'updated_at');
}

// ---------------------------------------------------------------- robots.txt / sitemap.xml
function robots(s, base, aiBlocked = []) {
  const rules = [...PRIVATE_PATHS, ...s.disallow];
  if (!s.index_home) rules.push('/$');
  const lines = ['User-agent: *', ...rules.map((p) => `Disallow: ${p}`), 'Allow: /', ''];
  // Clinics that asked AI assistants not to read their site.
  const clinicRules = aiBlocked.filter((x) => /^[a-z0-9-]+$/.test(x)).map((x) => `/${x}`);
  for (const [k, agent] of Object.entries(AI_BOTS)) {
    lines.push(`User-agent: ${agent}`);
    if (s.bots[k] === false) lines.push('Disallow: /');
    else lines.push(...rules.map((p) => `Disallow: ${p}`), ...clinicRules.map((p) => `Disallow: ${p}`), 'Allow: /');
    lines.push('');
  }
  lines.push(`Sitemap: ${base}/sitemap.xml`, '');
  return lines.join('\n');
}

async function sitemap(s, base) {
  const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const urls = [];
  if (s.index_home) urls.push({ loc: '/' }, { loc: '/features' }, { loc: '/pricing' });
  if (s.index_clinics) for (const c of await listedClinics()) urls.push({ loc: `/${c.slug}`, lastmod: c.updated_at });
  if (s.index_clinics) urls.push(...await require('../discover/directory.service').sitemapUrls()); // eslint-disable-line global-require -- clinic directory pages
  if (s.index_clinics) {
    // The other pages of published clinic websites (of clinics listed above).
    const listed = new Set(urls.map((u) => u.loc));
    for (const p of await require('../website/site.service').livePages()) if (listed.has(`/${p.slug}`)) urls.push({ loc: `/${p.slug}/p/${p.page}`, lastmod: p.at }); // eslint-disable-line global-require
  }
  const alt = (loc) => ['ar', 'en'].map((lc) => `<xhtml:link rel="alternate" hreflang="${lc}" href="${x(`${base}${loc}?lang=${lc}`)}"/>`).join('')
    + `<xhtml:link rel="alternate" hreflang="x-default" href="${x(base + loc)}"/>`;
  const body = urls.map((u) => `<url><loc>${x(base + u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}${alt(u.loc)}</url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${body}\n</urlset>\n`;
}

// ---------------------------------------------------------------- structured data (AEO)
const siteName = (s, locale) => L(s.site_name, locale) || brand.name;

function faqItems(site, locale) {
  const qa = [];
  for (const sec of (site && site.sections) || []) {
    if (sec.type !== 'faq' || sec.hidden) continue; // eslint-disable-line no-continue
    for (const it of (sec.data && sec.data.items) || []) {
      const q = strip(L(it.q, locale)); const a = strip(L(it.a, locale));
      if (q && a) qa.push({ q, a });
    }
  }
  return qa;
}

function homeLd({ s, mkt, site, base, locale, description, logoUrl }) {
  const name = siteName(s, locale);
  const orgId = `${base}/#organization`;
  const sameAs = Object.values(mkt.social || {}).filter(Boolean);
  const o = s.org || {};
  const out = [{
    '@context': 'https://schema.org', '@type': 'Organization', '@id': orgId, name, url: `${base}/`,
    ...(logoUrl ? { logo: logoUrl } : {}), ...(o.legal_name ? { legalName: o.legal_name } : {}), ...(sameAs.length ? { sameAs } : {}),
    ...(o.email || o.phone ? { contactPoint: [{ '@type': 'ContactPoint', contactType: 'customer support', ...(o.email ? { email: o.email } : {}), ...(o.phone ? { telephone: o.phone } : {}), availableLanguage: ['ar', 'en'] }] } : {}),
    ...(o.city || o.country ? { address: { '@type': 'PostalAddress', ...(o.city ? { addressLocality: o.city } : {}), ...(o.country ? { addressCountry: o.country } : {}) } } : {}),
  }, {
    '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${base}/#website`, name, url: `${base}/`, inLanguage: ['ar', 'en'], publisher: { '@id': orgId },
  }, {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name, url: `${base}/`, applicationCategory: 'BusinessApplication',
    applicationSubCategory: locale === 'ar' ? 'إدارة العيادات والحجوزات' : 'Clinic booking and management', operatingSystem: 'Web',
    inLanguage: ['ar', 'en'], ...(description ? { description } : {}), publisher: { '@id': orgId },
  }];
  const qa = faqItems(site, locale);
  if (qa.length) out.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qa.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) });
  return out;
}

// The clinic's specialty → a more precise schema.org type and medical specialty (MedicalClinic otherwise).
const SPECIALTY_LD = {
  dentistry: { type: 'Dentist', specialty: 'Dentistry' }, dermatology: { specialty: 'Dermatology' }, paediatrics: { specialty: 'Pediatric' },
  obgyn: { specialty: 'Obstetric' }, physiotherapy: { specialty: 'PhysicalTherapy' }, cardiology: { specialty: 'Cardiovascular' },
  ophthalmology: { specialty: 'Optometric' }, ent: { specialty: 'Otolaryngologic' }, psychiatry: { specialty: 'Psychiatric' },
  orthopaedics: { specialty: 'Musculoskeletal' }, nutrition: { specialty: 'DietNutrition' }, general: { specialty: 'PrimaryCare' },
};
const pairOf = (v, locale) => (v && (v[locale] || v[locale === 'en' ? 'ar' : 'en'])) || '';

/** schema.org MedicalClinic for /<slug>, with only the details the clinic really entered. */
function clinicLd({ clinic, doctors, base, locale, ws = null }) {
  const url = `${base}/${clinic.slug}`;
  const other = locale === 'en' ? clinic.name : clinic.name_en;
  const address = {
    ...(clinic.address ? { streetAddress: clinic.address } : {}), ...(clinic.city ? { addressLocality: clinic.city } : {}),
    ...(clinic.country && /^[A-Z]{2}$/i.test(clinic.country) ? { addressCountry: String(clinic.country).toUpperCase() } : {}),
  };
  const ld = {
    '@context': 'https://schema.org', '@type': 'MedicalClinic', '@id': `${url}#clinic`, name: clinic.displayName || clinic.name, url,
    ...(other && other !== (clinic.displayName || clinic.name) ? { alternateName: other } : {}),
    ...(clinic.aboutText ? { description: strip(clinic.aboutText).slice(0, 500) } : {}),
    ...(clinic.logo_mime ? { logo: `${base}/${clinic.slug}/logo?v=${clinic.logo_version}`, image: `${base}/${clinic.slug}/logo?v=${clinic.logo_version}` } : {}),
    ...(clinic.phone ? { telephone: clinic.phone } : {}),
    ...(clinic.email ? { email: clinic.email } : {}),
    ...(Object.keys(address).length ? { address: { '@type': 'PostalAddress', ...address } } : {}),
    ...(clinic.working_hours_text ? { openingHours: strip(clinic.working_hours_text).slice(0, 300) } : {}),
    ...(clinic.mapHref ? { hasMap: clinic.mapHref } : {}),
    ...(clinic.specialty ? { keywords: strip(clinic.specialty).slice(0, 120) } : {}),
  };
  const docs = (doctors || []).filter((d) => d && d.name);
  if (docs.length) {
    ld.member = docs.map((d) => ({
      '@type': 'Physician', name: d.name, ...(d.specialty ? { description: d.specialty } : {}),
      ...(clinic.booking_enabled ? { url: `${url}/book?doctor=${d.id}` } : {}),
    }));
  }
  if (clinic.reviews && clinic.reviews.count) Object.assign(ld, require('../reviews/reviews.service').jsonLd(clinic.reviews, locale)); // eslint-disable-line global-require -- verified reviews
  if (clinic.booking_enabled) ld.potentialAction ={ '@type': 'ReserveAction', target: { '@type': 'EntryPoint', urlTemplate: `${url}/book`, inLanguage: ['ar', 'en'] }, name: locale === 'ar' ? 'احجز موعدًا' : 'Book an appointment' };
  const out = [ld];
  if (!ws) return out;
  // Website (builder) details: precise type, map position, areas, price level, services and prices, profiles, FAQ.
  const sp = SPECIALTY_LD[clinic.specialtyKey];
  if (sp && sp.type) ld['@type'] = ['MedicalClinic', sp.type];
  if (sp && sp.specialty) ld.medicalSpecialty = sp.specialty;
  const sd = ws.seo || {};
  if (sd.geo) ld.geo = { '@type': 'GeoCoordinates', latitude: sd.geo.lat, longitude: sd.geo.lng };
  const area = pairOf(sd.area, locale);
  if (area) ld.areaServed = area.split(/[،,]/).map((a) => a.trim()).filter(Boolean).slice(0, 12).map((name) => ({ '@type': 'Place', name }));
  if (sd.price) ld.priceRange = sd.price;
  if (pairOf(sd.keywords, locale)) ld.keywords = [ld.keywords, pairOf(sd.keywords, locale)].filter(Boolean).join(', ').slice(0, 300);
  ld.isAcceptingNewPatients = Boolean(clinic.booking_enabled);
  ld.availableLanguage = ['ar', 'en'];
  if (ws.sameAs && ws.sameAs.length) ld.sameAs = ws.sameAs;
  const services = (ws.services || []).filter((x) => x && x.name).slice(0, 60);
  if (services.length) {
    ld.availableService = services.map((x) => ({ '@type': 'MedicalProcedure', name: x.name, ...(x.description ? { description: strip(x.description).slice(0, 300) } : {}) }));
    const priced = services.filter((x) => x.price !== null && x.price !== undefined);
    if (priced.length) ld.makesOffer = priced.map((x) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: x.name }, price: Number(x.price).toFixed(2), priceCurrency: clinic.currency || 'JOD' }));
  }
  const faq = (ws.faq || []).filter((x) => x && x.q && x.a).slice(0, 30);
  if (faq.length) {
    out.push({ '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: locale, mainEntity: faq.map((x) => ({ '@type': 'Question', name: strip(x.q).slice(0, 300), acceptedAnswer: { '@type': 'Answer', text: strip(x.a).slice(0, 1500) } })) });
  }
  if (ws.path && ws.pageName) {
    out.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: clinic.displayName || clinic.name, item: url },
      { '@type': 'ListItem', position: 2, name: ws.pageName, item: `${base}${ws.path}` },
    ] });
  }
  return out;
}

// ---------------------------------------------------------------- one clinic: llms.txt, robots.txt and sitemap.xml
/**
 * A factual summary of one clinic for AI assistants (llmstxt.org format), from its records and its website: the
 * clinic's own summary, contact, map position, doctors, services and prices, hours, FAQ and verified rating.
 * `base` is the address the clinic is reached at (its own domain, or the platform's /<slug>).
 */
function clinicLlms({ clinic, doc, doctors, services, reviews, base, siteBase }) {
  const sd = (doc && doc.seo) || {};
  const both = (v) => [v && v.ar, v && v.en].filter(Boolean);
  const lines = [`# ${clinic.name}${clinic.name_en && clinic.name_en !== clinic.name ? ` (${clinic.name_en})` : ''}`, ''];
  const summary = both(sd.ai && sd.ai.summary);
  const about = summary.length ? summary : [clinic.about, clinic.about_en].filter(Boolean);
  if (about.length) { about.forEach((a) => lines.push(`> ${strip(a).slice(0, 1500)}`)); lines.push(''); }
  const facts = [];
  if (clinic.specialty) facts.push(`Specialty: ${clinic.specialty}`);
  if (clinic.address || clinic.city) facts.push(`Address: ${[clinic.address, clinic.city].filter(Boolean).join(', ')}`);
  if (sd.geo) facts.push(`Map position: ${sd.geo.lat}, ${sd.geo.lng}`);
  if (both(sd.area).length) facts.push(`Areas served: ${both(sd.area).join(' / ')}`);
  if (clinic.phone) facts.push(`Phone: ${clinic.phone}`);
  if (clinic.whatsapp) facts.push(`WhatsApp: ${clinic.whatsapp}`);
  if (clinic.email) facts.push(`E-mail: ${clinic.email}`);
  if (sd.price) facts.push(`Price level: ${sd.price}`);
  facts.push(`Languages: Arabic, English`);
  facts.push(`Website: ${siteBase}`);
  if (clinic.booking_enabled) facts.push(`Book online: ${siteBase}/book`);
  if (reviews && reviews.count) facts.push(`Verified patient rating: ${reviews.avg}/5 from ${reviews.count} reviews`);
  lines.push(...facts.map((f) => `- ${f}`), '');
  if (doctors.length) {
    lines.push('## Doctors', '');
    doctors.forEach((d) => lines.push(`- ${d.name}${d.specialty ? ` — ${d.specialty}` : ''}${d.fee !== null && d.fee !== undefined ? ` — consultation ${d.fee} ${clinic.currency}` : ''}${clinic.booking_enabled ? ` — book: ${siteBase}/book?doctor=${d.id}` : ''}`));
    lines.push('');
  }
  if (services.length) {
    lines.push('## Services and prices', '');
    services.slice(0, 80).forEach((x) => lines.push(`- ${x.name}${x.price !== null && x.price !== undefined ? ` — ${x.price} ${clinic.currency}` : ''}${x.duration ? ` — ${x.duration} min` : ''}`));
    lines.push('');
  }
  if (clinic.working_hours_text) lines.push('## Working hours', '', strip(clinic.working_hours_text), '');
  const faq = ((doc && doc.pages) || []).flatMap((p) => p.sections).filter((x) => x.type === 'faq' && x.visible)
    .flatMap((x) => ['ar', 'en'].flatMap((l) => (x.content[l] && x.content[l].items) || [])).filter((x) => x.q && x.a);
  if (faq.length) { lines.push('## Frequently asked questions', ''); faq.slice(0, 40).forEach((x) => lines.push(`### ${strip(x.q)}`, '', strip(x.a), '')); }
  const pages = ((doc && doc.pages) || []).filter((p) => p.key !== 'home');
  if (pages.length) { lines.push('## Pages', ''); pages.forEach((p) => lines.push(`- [${(p.title && (p.title.en || p.title.ar)) || p.slug}](${siteBase}/p/${p.slug})`)); lines.push(''); }
  lines.push(`Facts come from the clinic's own records on ${base}. Prices and availability can change; the booking page shows the current free times.`, '');
  return lines.join('\n');
}

function clinicRobots({ siteBase, slugPrefix, blockAi, hide }) {
  const lines = ['User-agent: *', `Disallow: ${slugPrefix}/book/`, `Disallow: ${slugPrefix}/login`];
  if (hide) lines.push('Disallow: /');
  lines.push('Allow: /', '');
  if (blockAi) for (const agent of Object.values(AI_BOTS)) lines.push(`User-agent: ${agent}`, 'Disallow: /', '');
  lines.push(`Sitemap: ${siteBase}/sitemap.xml`, '');
  return lines.join('\n');
}

function clinicSitemap({ siteBase, doc, doctors, at }) {
  const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const locs = ['', '/book', ...((doc && doc.pages) || []).filter((p) => p.key !== 'home').map((p) => `/p/${p.slug}`), ...(doc ? doctors.map((d) => `/doctors/${d.id}`) : [])];
  const alt = (loc) => ['ar', 'en'].map((lc) => `<xhtml:link rel="alternate" hreflang="${lc}" href="${x(`${siteBase}${loc}?lang=${lc}`)}"/>`).join('');
  const body = locs.map((l) => `<url><loc>${x(siteBase + l)}</loc>${at ? `<lastmod>${new Date(at).toISOString().slice(0, 10)}</lastmod>` : ''}${alt(l)}</url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${body}\n</urlset>\n`;
}

// ---------------------------------------------------------------- llms.txt (GEO)
/** A factual plain-language summary for AI assistants, built from the live landing content and the listed clinics. */
async function llmsDefault({ s, site, base }) {
  const name = siteName(s, 'en');
  const lines = [`# ${name}`, ''];
  const desc = L(s.description, 'en') || L(site && site.seo && site.seo.description, 'en');
  if (desc) lines.push(`> ${strip(desc)}`, '');
  const sections = ((site && site.sections) || []).filter((x) => !x.hidden);
  const hero = sections.find((x) => x.type === 'hero');
  if (hero) {
    const h = hero.data || {};
    const en = [strip(`${L(h.title, 'en')} ${L(h.title_accent, 'en')}`), strip(L(h.lead, 'en'))].filter(Boolean);
    const ar = [strip(`${L(h.title, 'ar')} ${L(h.title_accent, 'ar')}`), strip(L(h.lead, 'ar'))].filter(Boolean);
    lines.push(...en, '', ...ar, '');
  }
  lines.push(`${name} is a web application for clinics, in Arabic and English. Each clinic on ${name} gets a public page at ${base}/<clinic-address> with its doctors, services and contact details, and — when the clinic turns it on — online booking at ${base}/<clinic-address>/book.`, '');
  const feats = sections.filter((x) => ['features', 'roles', 'steps'].includes(x.type));
  for (const f of feats) {
    const title = strip(L(f.data && f.data.title, 'en'));
    const items = ((f.data && f.data.items) || []).map((it) => [strip(L(it.title, 'en')), strip(L(it.text, 'en'))]).filter(([t]) => t);
    if (!items.length) continue; // eslint-disable-line no-continue
    lines.push(`## ${title || 'Features'}`);
    for (const [t, x] of items) lines.push(`- ${t}${x ? `: ${x}` : ''}`);
    lines.push('');
  }
  lines.push('## Main pages', `- [Home](${base}/): what ${name} does (Arabic and English; add ?lang=en or ?lang=ar)`, `- [Create a clinic account](${base}/signup)`, `- [Sign in](${base}/login)`, '');
  if (s.index_clinics) {
    const clinics = await listedClinics(200);
    if (clinics.length) {
      lines.push('## Clinic pages with online booking');
      for (const c of clinics) {
        const label = [c.name_en || c.name, c.name_en && c.name !== c.name_en ? c.name : '', c.specialty, c.city].map(strip).filter(Boolean).join(' · ');
        lines.push(`- [${label}](${base}/${c.slug})`);
      }
      lines.push('');
    }
  }
  const qa = faqItems(site, 'en');
  if (qa.length) {
    lines.push('## Frequently asked questions');
    for (const x of qa) lines.push(`### ${x.q}`, x.a, '');
  }
  return `${lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim()}\n`;
}

// ---------------------------------------------------------------- <head> for public pages
/**
 * Tags for a public page. kind: 'home' | 'cookies' (marketing pages, may load pixels after consent) |
 * 'clinic' (clinic page: structured data, never pixels) | 'private' (noindex, nothing else).
 */
async function head(req, res, { kind, site, clinic, doctors, title: pageTitle, description: pageDesc, shareImage = null, hide = false, ws = null }) {
  const [s, mkt, media] = await Promise.all([get(), marketing(), require('./media.service').map()]); // eslint-disable-line global-require
  const locale = req.locale;
  const base = baseUrl(req, s);
  const name = siteName(s, locale);
  if (kind === 'private') return { title: pageTitle ? `${pageTitle} · ${name}` : name, html: '<meta name="robots" content="noindex, nofollow">' };
  const siteContent = site || await content.get();
  // A clinic's own connections (Website → Connections): verification codes, profiles (sameAs) and pixels.
  const clinicMkt = kind === 'clinic' && clinic && clinic.id ? await require('../website/marketing.service').get(clinic.id) : null; // eslint-disable-line global-require
  if (clinicMkt) {
    const extra = require('../website/marketing.service').profileLinks(clinicMkt); // eslint-disable-line global-require
    ws = { ...(ws || {}), sameAs: [...new Set([...((ws && ws.sameAs) || []), ...extra])] }; // eslint-disable-line no-param-reassign
  }
  const path = kind === 'clinic' ? ((ws && ws.path) || `/${clinic.slug}`) : kind === 'cookies' ? '/preferences/cookies' : kind === 'pricing' ? '/pricing' : kind === 'features' ? '/features' : '/';
  let title; let description; let noindex = false;
  if (kind === 'home') {
    title = L(s.title, locale) || L(siteContent.seo && siteContent.seo.title, locale) || name;
    description = L(s.description, locale) || L(siteContent.seo && siteContent.seo.description, locale);
    noindex = !s.index_home;
  } else if (kind === 'pricing' || kind === 'features') {
    title = `${pageTitle} · ${name}`;
    description = pageDesc || '';
    noindex = !s.index_home;
  } else if (kind === 'clinic') {
    title = pageTitle || clinic.displayName;
    description = pageDesc || '';
    noindex = !s.index_clinics || !clinic.booking_enabled || !clinic.onboarding_completed_at || Boolean(hide);
  } else {
    title = `${pageTitle} · ${name}`;
    description = pageDesc || '';
    noindex = true;
  }
  description = strip(description).slice(0, 320);
  const tags = [];
  const m = (n, c, attr = 'name') => { if (c) tags.push(`<meta ${attr}="${esc(n)}" content="${esc(c)}">`); };
  m('description', description);
  if (noindex) m('robots', 'noindex, follow');
  if (kind === 'clinic' && ws) {
    const sd = ws.seo || {};
    if (sd.ai && sd.ai.bots === 'block') m('robots', 'noai, noimageai'); // AI crawlers: the clinic asked them not to use its pages
    m('keywords', pairOf(sd.keywords, locale));
    // Local search: position, place and region.
    if (sd.geo) { m('geo.position', `${sd.geo.lat};${sd.geo.lng}`); m('ICBM', `${sd.geo.lat}, ${sd.geo.lng}`); }
    if (clinic.city) m('geo.placename', clinic.city);
    if (clinic.country && /^[A-Z]{2}$/i.test(clinic.country)) m('geo.region', String(clinic.country).toUpperCase());
    tags.push(`<link rel="alternate" type="text/plain" title="llms.txt" href="${esc(`${base}/${clinic.slug}/llms.txt`)}">`);
  }
  const url = `${base}${path}`;
  tags.push(`<link rel="canonical" href="${esc(`${url}?lang=${locale}`)}">`);
  for (const lc of ['ar', 'en']) tags.push(`<link rel="alternate" hreflang="${lc}" href="${esc(`${url}?lang=${lc}`)}">`);
  tags.push(`<link rel="alternate" hreflang="x-default" href="${esc(url)}">`);
  const og = s.og_image && media[s.og_image] ? media[s.og_image] : null;
  const clinicImg = kind === 'clinic' && clinic.logo_mime ? `${base}/${clinic.slug}/logo?v=${clinic.logo_version}` : null;
  m('og:type', 'website', 'property');
  m('og:site_name', name, 'property');
  m('og:title', title, 'property');
  m('og:description', description, 'property');
  m('og:url', `${url}?lang=${locale}`, 'property');
  if (kind === 'clinic' && shareImage) m('og:image', `${base}${shareImage}`, 'property'); // the website's own share image
  else if (clinicImg) m('og:image', clinicImg, 'property');
  else if (og) {
    m('og:image', `${base}${og.url}`, 'property');
    if (og.width && og.height) { m('og:image:width', String(og.width), 'property'); m('og:image:height', String(og.height), 'property'); }
  }
  m('og:locale', locale === 'ar' ? 'ar_AR' : 'en_US', 'property');
  m('og:locale:alternate', locale === 'ar' ? 'en_US' : 'ar_AR', 'property');
  m('twitter:card', (kind === 'clinic' && shareImage) || (og && !clinicImg) ? 'summary_large_image' : 'summary');
  if (s.x_handle) m('twitter:site', `@${s.x_handle}`);
  if (kind === 'home') { m('google-site-verification', s.verify.google); m('msvalidate.01', s.verify.bing); }
  if (clinicMkt) { m('google-site-verification', clinicMkt.verify.google); m('msvalidate.01', clinicMkt.verify.bing); }
  const ld = kind === 'home' ? homeLd({ s, mkt, site: siteContent, base, locale, description, logoUrl: `${base}${brand.favicon || '/favicon.svg'}` })
    : kind === 'clinic' ? clinicLd({ clinic, doctors, base, locale, ws }) : [];
  for (const d of ld) tags.push(`<script type="application/ld+json">${ldJson(d)}</script>`);

  // Pixels: marketing pages only, only with the visitor's consent.
  const marketingPage = kind === 'home' || kind === 'cookies' || kind === 'pricing' || kind === 'features';
  const pixelsOn = marketingPage && hasPixels(mkt);
  const consent = consentOf(req);
  let pixels = null;
  if (pixelsOn && consent === 'yes') {
    pixels = Object.fromEntries(Object.entries(mkt.pixels).filter(([k, v]) => v && PIXELS[k]));
    applyPixelCsp(res, pixels);
  }
  // A clinic's website: its own pixels, after the visitor accepts THAT clinic's cookie notice.
  if (clinicMkt && Object.values(clinicMkt.pixels).some(Boolean)) {
    const scope = `c${clinic.id}`;
    const choice = consentOf(req, scope);
    let ids = null;
    if (choice === 'yes') { ids = Object.fromEntries(Object.entries(clinicMkt.pixels).filter(([k, v]) => v && PIXELS[k] && k !== 'gtm')); applyPixelCsp(res, ids); }
    return { title, html: tags.join('\n'), pixels: ids, askConsent: !choice, pixelsOn: true, consent: choice, consentScope: scope };
  }
  return { title, html: tags.join('\n'), pixels, askConsent: pixelsOn && !consent, pixelsOn, consent };
}

// ---------------------------------------------------------------- checker
async function checks({ s, mkt, site, media }) {
  const out = [];
  const both = (v) => Boolean(v && v.ar && v.en);
  const desc = [L(s.description, 'ar'), L(s.description, 'en')];
  out.push({ key: 'title', ok: both(s.title) });
  out.push({ key: 'description', ok: desc.every((d) => d.length >= 50 && d.length <= 170) });
  out.push({ key: 'og_image', ok: Boolean(s.og_image && media[s.og_image]) });
  out.push({ key: 'base_url', ok: /^https:\/\//.test(s.base_url) || (!s.base_url && /^https:\/\//.test(process.env.APP_URL || '')) });
  out.push({ key: 'verify', ok: Boolean(s.verify.google || s.verify.bing) });
  out.push({ key: 'org', ok: Boolean(s.org.email || s.org.phone) });
  out.push({ key: 'social', ok: Object.keys(mkt.social || {}).length > 0 });
  out.push({ key: 'faq', ok: faqItems(site, 'ar').length + faqItems(site, 'en').length > 0 });
  out.push({ key: 'home_indexed', ok: s.index_home });
  const clinics = s.index_clinics ? await listedClinics() : [];
  const incomplete = clinics.filter((c) => !c.phone || !c.address || !c.city);
  out.push({ key: 'clinics', ok: s.index_clinics && clinics.length > 0, n: clinics.length });
  out.push({ key: 'clinic_details', ok: incomplete.length === 0, n: incomplete.length, list: incomplete.slice(0, 8) });
  return out;
}

module.exports = {
  AI_BOTS, SOCIAL, PIXELS, PRIVATE_PATHS, CONSENT_COOKIE, consentCookie, get, save, marketing, saveMarketing, hasPixels, consentOf, applyPixelCsp,
  baseUrl, listedClinics, robots, sitemap, homeLd, clinicLd, clinicLlms, clinicRobots, clinicSitemap, llmsDefault, head, checks, ldJson, cleanBase, validSocial, L,
};
