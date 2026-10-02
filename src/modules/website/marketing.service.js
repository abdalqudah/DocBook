// A clinic's own connections (Website → Connections, /app/website/marketing):
//   social   — profile links (the hosts are checked per network), shown in the website footer and as sameAs data;
//   google   — Google Business Profile and its "write a review" link;
//   verify   — Google Search Console / Bing Webmaster verification codes (meta tags on the clinic's pages);
//   pixels   — GA4, Meta, TikTok, Snap, LinkedIn and X ids, loaded on the clinic's website pages (no Tag Manager)
//              only after the visitor accepts that clinic's cookie notice (never on booking, sign-in or /app pages).
// Kept on businesses.marketing (JSON). Every value is validated here; nothing free-form reaches a page.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const seo = require('../site/seo.service');

// Social networks a clinic can link (keys shared with the platform's list) + the hosts accepted for each.
const SOCIAL = {
  facebook: { hosts: ['facebook.com', 'fb.com'], icon: 'facebook' },
  instagram: { hosts: ['instagram.com'], icon: 'instagram' },
  x: { hosts: ['x.com', 'twitter.com'], icon: 'twitter' },
  tiktok: { hosts: ['tiktok.com'], icon: 'music' },
  snapchat: { hosts: ['snapchat.com'], icon: 'ghost' },
  youtube: { hosts: ['youtube.com', 'youtu.be'], icon: 'youtube' },
  linkedin: { hosts: ['linkedin.com'], icon: 'linkedin' },
  whatsapp: { hosts: ['wa.me', 'whatsapp.com'], icon: 'message-circle' },
  telegram: { hosts: ['t.me', 'telegram.me'], icon: 'send' },
};
const GOOGLE_HOSTS = ['google.com', 'g.page', 'goo.gl', 'maps.app.goo.gl', 'business.google.com', 'g.co'];
// Clinics get the fixed-code pixels only: a Google Tag Manager container can run any script the container's owner
// writes, on this platform's origin (where staff sign in), so it is kept for the platform's own pages.
const PIXELS = Object.keys(seo.PIXELS).filter((k) => k !== 'gtm');

const parse = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) || {}; } catch { return {}; } };
const hostOk = (url, hosts) => {
  try {
    const u = new URL(String(url).trim());
    const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && !u.username && hosts.some((x) => h === x || h.endsWith(`.${x}`)) ? u.toString() : null;
  } catch { return null; }
};

const empty = () => ({ social: {}, google: { business: '', review: '' }, verify: { google: '', bing: '' }, pixels: {} });

/** The clinic's connections (cached briefly — read on every public page). */
const get = (businessId) => cache.remember(`mkt:${businessId}`, async () => {
  const row = await knex('businesses').where({ id: businessId }).first('marketing');
  const v = parse(row && row.marketing);
  const e = empty();
  const px = { ...(v.pixels || e.pixels) }; delete px.gtm; // a container saved before is not loaded any more
  return { social: v.social || e.social, google: { ...e.google, ...(v.google || {}) }, verify: { ...e.verify, ...(v.verify || {}) }, pixels: px };
}, 60_000);

/** Validates the form (s_<net>, g_business, g_review, v_google, v_bing, p_<pixel>) → { value, errors }. */
function parseForm(body = {}) {
  const errors = {};
  const out = empty();
  for (const k of Object.keys(SOCIAL)) {
    const raw = String(body[`s_${k}`] || '').trim();
    if (!raw) continue; // eslint-disable-line no-continue
    const ok = hostOk(raw, SOCIAL[k].hosts);
    if (ok) out.social[k] = ok; else errors[`s_${k}`] = 'clinic_mkt.err_link';
  }
  for (const k of ['business', 'review']) {
    const raw = String(body[`g_${k}`] || '').trim();
    if (!raw) continue; // eslint-disable-line no-continue
    const ok = hostOk(raw, GOOGLE_HOSTS);
    if (ok) out.google[k] = ok; else errors[`g_${k}`] = 'clinic_mkt.err_google';
  }
  for (const k of ['google', 'bing']) {
    // People paste the whole <meta …> tag: keep only the code.
    let raw = String(body[`v_${k}`] || '').trim();
    const m = raw.match(/content=["']([^"']+)["']/i); if (m) raw = m[1];
    if (!raw) continue; // eslint-disable-line no-continue
    if (/^[A-Za-z0-9_-]{6,100}$/.test(raw)) out.verify[k] = raw; else errors[`v_${k}`] = 'clinic_mkt.err_code';
  }
  for (const k of PIXELS) {
    const raw = String(body[`p_${k}`] || '').trim();
    if (!raw) continue; // eslint-disable-line no-continue
    if (seo.PIXELS[k].re.test(raw)) out.pixels[k] = raw; else errors[`p_${k}`] = 'clinic_mkt.err_pixel';
  }
  return { value: out, errors };
}

async function save(ctx, body) {
  const { value, errors } = parseForm(body);
  if (Object.keys(errors).length) throw E.validation(errors);
  const before = await get(ctx.businessId);
  await knex('businesses').where({ id: ctx.businessId }).update({ marketing: JSON.stringify(value), updated_at: new Date() });
  cache.forgetPrefix(`mkt:${ctx.businessId}`);
  const keys = (o) => Object.keys(o).filter((k) => o[k]).join(', ') || '—';
  await audit.record(ctx, 'website.connections_updated', {
    entityType: 'business', entityId: ctx.businessId,
    oldValues: { social: keys(before.social), pixels: keys(before.pixels), verify: keys(before.verify), google: keys(before.google) },
    newValues: { social: keys(value.social), pixels: keys(value.pixels), verify: keys(value.verify), google: keys(value.google) },
  });
  return value;
}

/** Links for the footer and sameAs: social profiles + the Google Business Profile. */
function profileLinks(m) {
  return [...Object.values(m.social || {}), m.google && m.google.business].filter(Boolean);
}

module.exports = { SOCIAL, GOOGLE_HOSTS, PIXELS, get, parseForm, save, profileLinks };
