// Renders a website document (draft preview or the live version) with the clinic's facts read live: doctors, services,
// prices, reviews, insurers, hours, contact. One renderer for both, so the preview is exactly what will go live.
const knex = require('../../db/knex');
const theme = require('../branding/theme');
const sections = require('./sections');

const WEEK = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const parse = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

/** id → URL of the document's images: public addresses on the live site, member-only ones in the preview. */
async function mediaUrls(clinic, doc, { preview }) {
  const ids = sections.mediaIn(doc);
  if (!ids.length) return {};
  const rows = await knex('clinic_media').where({ business_id: clinic.id }).whereIn('id', ids).select('id', 'sha', 'is_public', 'alt_ar', 'alt_en', 'width', 'height');
  const out = {};
  rows.forEach((m) => {
    if (preview) out[m.id] = { url: `/app/media/${m.id}?v=${m.sha}`, alt_ar: m.alt_ar, alt_en: m.alt_en, width: m.width, height: m.height };
    else if (m.is_public && clinic.slug) out[m.id] = { url: `/m/${clinic.slug}/${m.id}?v=${m.sha}`, alt_ar: m.alt_ar, alt_en: m.alt_en, width: m.width, height: m.height };
  });
  return out;
}

/** The clinic's week (settings → hours) as rows for the hours section: [{ day, shifts:[{start,end}] | [] }]. */
function hoursRows(clinic) {
  const week = parse(clinic.default_working_hours);
  if (!week) return [];
  return WEEK.map((day) => ({ day, shifts: week[day] && week[day].enabled ? (week[day].shifts || []) : [] }));
}

/**
 * Everything a site page needs. `portal` = { listDoctors, listServices } from site/portal.web.js (shared with the
 * classic page and the booking pages).
 */
async function locals(req, clinic, doc, { preview = false, portal, page: chosen = null }) {
  const page = chosen || doc.pages.find((p) => p.key === 'home') || { sections: [] };
  const shown = page.sections.filter((s) => s.visible && !(s.type === 'announcement' && !announcementOn(s, req)));
  const types = new Set(shown.map((s) => s.type));
  const [doctors, services, media, insurers, reviews] = await Promise.all([
    types.has('doctors') || types.has('services') ? portal.listDoctors(req, clinic) : [],
    types.has('services') ? portal.listServices(req, clinic) : [],
    mediaUrls(clinic, doc, { preview }),
    types.has('insurance') ? knex('insurance_providers').where({ business_id: clinic.id, is_active: true }).orderBy([{ column: 'sort_order' }, { column: 'name' }]).pluck('name') : [],
    types.has('reviews') || types.has('doctors') ? require('../reviews/reviews.service').publicSummary(clinic.id) : null, // eslint-disable-line global-require
  ]);
  const other = req.locale === 'en' ? 'ar' : 'en';
  // The clinic's own words in the visitor's language, falling back to the other language.
  const words = (s) => {
    const mine = (s.content && s.content[req.locale]) || {}; const alt = (s.content && s.content[other]) || {};
    return new Proxy({}, { get: (_, k) => (typeof k === 'string' ? (mine[k] && (!Array.isArray(mine[k]) || mine[k].length) ? mine[k] : alt[k]) : undefined) });
  };
  const img = (id) => (id && media[id]) || null;
  return {
    doc, page, sections: shown.map((s) => ({ ...s, c: words(s) })), doctors, services, insurers, hours: hoursRows(clinic), media, img,
    wsSite: siteChrome(req, clinic, doc, page, { preview, img }),
    doctorNames: Object.fromEntries(doctors.map((d) => [d.id, d.name])), reviewsSummary: reviews, preview,
  };
}

/**
 * Menu and footer of a builder site: links resolved to addresses (home, a page, a section of the home page, booking,
 * call, WhatsApp). In the builder's preview the links stay inside the preview.
 */
function siteChrome(req, clinic, doc, page, { preview, img }) {
  const L = (v) => (v && (v[req.locale] || v[req.locale === 'en' ? 'ar' : 'en'])) || '';
  const base = `/${clinic.slug}`;
  const pageHref = (p) => (preview ? `/app/website/preview?page=${p.key}` : (p.key === 'home' ? base : `${base}/p/${p.slug}`));
  const pages = doc.pages.map((p) => ({ key: p.key, title: p.key === 'home' ? req.t('website.page_home') : L(p.title), href: pageHref(p), menu: p.key === 'home' || p.menu }));
  const sectionTitle = (id) => { const s = doc.pages[0].sections.find((x) => x.id === id); return s ? (L({ ar: s.content.ar && s.content.ar.title, en: s.content.en && s.content.en.title }) || req.t(`website.sec.${s.type}`)) : ''; };
  const header = doc.header || {};
  let items = (header.items || []).map((it) => {
    const label = L(it.label);
    switch (it.kind) {
      case 'home': return { label: label || req.t('website.page_home'), href: pageHref(doc.pages[0]), current: page.key === 'home' };
      case 'page': { const p = doc.pages.find((x) => x.key === it.target); return p ? { label: label || L(p.title), href: pageHref(p), current: page.key === p.key } : null; }
      case 'section': return { label: label || sectionTitle(it.target), href: `${pageHref(doc.pages[0])}#s-${it.target}` };
      case 'book': return clinic.booking_enabled ? { label: label || req.t('portal.book'), href: `${base}/book` } : null;
      case 'call': return clinic.telHref ? { label: label || req.t('portal.call'), href: clinic.telHref } : null;
      case 'whatsapp': return clinic.waHref ? { label: label || req.t('portal.whatsapp'), href: clinic.waHref, ext: true } : null;
      default: return null;
    }
  }).filter((x) => x && x.label);
  // No menu chosen: the pages marked "in the menu" (only when there is more than the home page).
  if (!(header.items || []).length) items = pages.length > 1 ? pages.filter((p) => p.menu).map((p) => ({ label: p.title, href: p.href, current: p.key === page.key })) : [];
  const logo = doc.brand && doc.brand.logoMediaId ? img(doc.brand.logoMediaId) : null;
  return { header, footer: doc.footer || {}, items, pages, logo, homeHref: pageHref(doc.pages[0]), preview, L };
}

function announcementOn(s, req) {
  const today = (req.ctx && req.ctx.today) || new Date().toISOString().slice(0, 10);
  const { from, to } = s.settings || {};
  return (!from || from <= today) && (!to || to >= today);
}

// Presentation tokens of the website document → CSS custom properties (no colour ever written into a view).
const FONT_STACK = {
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Arabic', Tahoma, Arial, sans-serif",
  humanist: "'Segoe UI', 'Noto Sans', 'Noto Sans Arabic', 'Helvetica Neue', Tahoma, Arial, sans-serif",
  serif: "Georgia, 'Noto Serif', 'Noto Naskh Arabic', 'Times New Roman', serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Noto Sans Arabic', system-ui, sans-serif",
};
const RADIUS = { soft: '10px', rounded: '18px', square: '4px' };

function css(doc, clinic) {
  const b = (doc && doc.brand) || {};
  const primary = b.primary || (clinic && theme.HEX.test(clinic.color || '') ? clinic.color : null);
  let out = primary ? theme.businessCss(primary) : '';
  const vars = [`--site-font: ${FONT_STACK[b.font] || FONT_STACK.system};`, `--site-radius: ${RADIUS[b.radius] || RADIUS.rounded};`];
  if (b.secondary) vars.push(`--accent: ${b.secondary};`, `--accent-soft: color-mix(in srgb, ${b.secondary} 16%, transparent);`);
  out += `:root { ${vars.join(' ')} }\n`;
  return out;
}

module.exports = { locals, css, mediaUrls, hoursRows, WEEK, FONT_STACK };
