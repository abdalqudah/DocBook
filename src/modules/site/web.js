// Public landing page (rendered from the editable content in content.service.js), the media files it uses,
// the cookie-preferences page, and the files search engines and AI assistants read
// (robots.txt, sitemap.xml, llms.txt — see seo.service.js).
const express = require('express');
const config = require('../../config');
const { wrap } = require('../../routes/helpers');
const site = require('./content.service');
const media = require('./media.service');
const seo = require('./seo.service');
const pricing = require('./pricing');

const router = express.Router();

/** Layout classes of an editable section: alignment and background. */
function secCls(s) {
  const d = (s && s.design) || {};
  const c = [];
  if (['start', 'center', 'end'].includes(d.align)) c.push(`al-${d.align}`);
  if (d.background === 'muted') c.push('sec-muted');
  if (d.background === 'image' && d.bg_image) c.push('sec-has-bg');
  return c.join(' ');
}

/** Loads the header/footer content, media and social links for every public page (cached for a minute). */
async function chrome(req, res, next) {
  try {
    res.locals.L = site.pick(req.locale);
    res.locals.secCls = secCls;
    res.locals.siteMedia = {};
    if (req.method === 'GET' && !req.path.startsWith('/app')) {
      const [c, m, mk] = await Promise.all([site.get(), media.map(), seo.marketing()]);
      res.locals.siteChrome = c;
      res.locals.siteMedia = m;
      res.locals.siteSocial = Object.entries(mk.social || {}).map(([k, href]) => ({ key: k, href, icon: (seo.SOCIAL[k] || {}).icon || 'link' }));
    }
    next();
  } catch (err) { next(err); }
}

/** The plans for the pricing section — only read when the page has one. */
const landingPricing = (content) => (content.sections.some((s) => s.type === 'pricing') ? pricing.forSite() : null);

router.get('/', wrap(async (req, res) => {
  const content = await site.get();
  const [head, pricingData] = await Promise.all([seo.head(req, res, { kind: 'home', site: content }), landingPricing(content)]);
  res.page('pages/site/home', { layout: 'public', bodyClass: 'lp-modern', content, pricing: pricingData, pageTitle: head.title, seoHead: head });
}));

// The plans on a page of their own: the pricing section's texts (as the admin edited them on the home page), the cards,
// a full comparison table, the pricing questions and the call to action. Without public plans it says so.
/** Questions about paying, asked on /pricing only (from the translation files). */
function pricingFaq() {
  const { translator } = require('../../core/i18n'); // eslint-disable-line global-require
  const ar = translator('ar'); const en = translator('en');
  return ['pay', 'trial', 'cancel'].map((k) => ({ q: { ar: ar(`site.pricing.faq.${k}_q`), en: en(`site.pricing.faq.${k}_q`) }, a: { ar: ar(`site.pricing.faq.${k}_a`), en: en(`site.pricing.faq.${k}_a`) } }));
}

router.get('/pricing', wrap(async (req, res) => {
  const content = await site.get();
  const sec = content.sections.find((s) => s.type === 'pricing') || site.defaults().sections.find((s) => s.type === 'pricing');
  const faq = site.defaults().sections.find((s) => s.type === 'faq');
  const cta = content.sections.find((s) => s.type === 'cta' && !s.hidden) || site.defaults().sections.find((s) => s.type === 'cta');
  const L = site.pick(req.locale);
  const head = await seo.head(req, res, { kind: 'pricing', site: content, title: L(sec.data.title) || req.t('site.d.nav.pricing'), description: L(sec.data.lead) });
  res.page('pages/site/pricing', {
    layout: 'public', bodyClass: 'lp-modern lp-pricing-page', pageTitle: head.title, seoHead: head, content,
    sec: { ...sec, id: 'pricing-page', anchor: 'plans', hidden: false, design: {} },
    faq: { ...faq, id: 'pricing-faq', anchor: 'questions', hidden: false, design: {}, data: { ...faq.data, lead: { ar: '', en: '' }, items: [...faq.data.items.slice(-2), ...pricingFaq()] } },
    cta, pricing: await pricing.forSite(), compare: pricing.COMPARE,
  });
}));

// ---------------------------------------------------------------- media files
router.get('/assets/media/:id/:file', wrap(async (req, res, next) => {
  const [sha] = String(req.params.file).split('.');
  const f = await media.file(req.params.id, sha);
  if (!f) return next();
  if (req.get('if-none-match') === `"${f.sha}"`) return res.status(304).end();
  res.set({
    'Content-Type': f.mime, 'Content-Length': String(f.data.length), 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000, immutable', ETag: `"${f.sha}"`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'Cross-Origin-Resource-Policy': 'same-site',
    'Content-Disposition': 'inline',
  });
  return res.end(f.data);
}));

// ---------------------------------------------------------------- cookie preferences
router.get('/preferences/cookies', wrap(async (req, res) => {
  const head = await seo.head(req, res, { kind: 'cookies', title: req.t('growth.cookies_title'), description: req.t('growth.cookies_sub') });
  const mk = await seo.marketing();
  const tools = Object.keys(mk.pixels || {}).filter((k) => mk.pixels[k] && seo.PIXELS[k]).map((k) => seo.PIXELS[k].name);
  res.page('pages/site/cookies', { layout: 'public', pageTitle: head.title, seoHead: head, tools, consent: head.consent, noConsentBanner: true });
}));

const BACK_OK = /^\/(?:preferences\/cookies)?(?:\?lang=(?:ar|en))?(?:#[a-z0-9-]*)?$/;
router.post('/preferences/cookies', (req, res) => {
  const choice = req.body.choice === 'accept' ? 'yes' : req.body.choice === 'reject' ? 'no' : null;
  if (choice) res.cookie(seo.CONSENT_COOKIE, choice, { maxAge: 180 * 86_400_000, sameSite: 'lax', httpOnly: true, secure: config.isProd });
  const back = String(req.body.back || '');
  res.redirect(BACK_OK.test(back) ? back : '/');
});

// ---------------------------------------------------------------- search engines and AI assistants
router.get('/robots.txt', wrap(async (req, res) => {
  const s = await seo.get();
  const blocked = await require('../website/site.service').aiBlockedSlugs(); // eslint-disable-line global-require
  res.set('Cache-Control', 'public, max-age=3600').type('text/plain; charset=utf-8').send(seo.robots(s, seo.baseUrl(req, s), blocked));
}));

router.get('/sitemap.xml', wrap(async (req, res) => {
  const s = await seo.get();
  res.set('Cache-Control', 'public, max-age=3600').type('application/xml; charset=utf-8').send(await seo.sitemap(s, seo.baseUrl(req, s)));
}));

router.get('/llms.txt', wrap(async (req, res) => {
  const s = await seo.get();
  const text = s.llms || await seo.llmsDefault({ s, site: await site.get(), base: seo.baseUrl(req, s) });
  res.set('Cache-Control', 'public, max-age=3600').type('text/plain; charset=utf-8').send(text.endsWith('\n') ? text : `${text}\n`);
}));

module.exports = router;
module.exports.chrome = chrome;
module.exports.secCls = secCls;
module.exports.landingPricing = landingPricing;
