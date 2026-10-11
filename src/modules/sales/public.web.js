// The customer's links: /quote/<token> a quotation (view, print, accept with a signature, decline or negotiate) and
// /invoice/<token> a platform subscription invoice. No account needed: the link itself is the key.
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const sales = require('./sales.service');
const response = require('./response.service');

const router = express.Router();
// The customer's answers and card payments from a link: each one e-mails the team or opens a payment, so a link
// cannot be used to flood either.
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(require('../../core/errors').E.rateLimited()) }); // eslint-disable-line global-require
const noIndex = (res) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Referrer-Policy', 'no-referrer'); };
// The platform's team opening a link from the admin is not counted as the customer viewing it.
const isTeam = (req) => Boolean(req.user && req.user.is_platform_admin);
/** The document in its own language, unless the visitor picked one (?lang=). */
function asLocale(req, res, locale) {
  if (req.query.lang || !['ar', 'en'].includes(locale) || res.locals.locale === locale) return;
  const { translator } = require('../../core/i18n'); // eslint-disable-line global-require
  Object.assign(res.locals, { locale, dir: locale === 'ar' ? 'rtl' : 'ltr', t: translator(locale) });
  req.t = res.locals.t; // eslint-disable-line no-param-reassign
}

async function renderQuote(req, res, extra = {}) {
  noIndex(res);
  const q = await sales.quoteByToken(req.params.token, { count: req.method === 'GET' && !isTeam(req) });
  if (q.status === 'draft' && !isTeam(req)) throw new AppError('NOT_FOUND', 'Page not found.', 404);
  asLocale(req, res, q.locale);
  res.page('pages/sales/quote-public', {
    layout: 'document', title: `${res.locals.t('sales.quotation')} ${q.number}`, q, state: sales.quoteState(q), p: await sales.profile(),
    events: (await sales.events(q.id)).filter((e) => e.type !== 'revised' || e.message), reasons: response.DECLINE_REASONS,
    tab: ['accept', 'negotiate', 'decline'].includes(req.query.tab) ? req.query.tab : 'accept', errors: {}, old: null, pageScripts: ['/js/sign.js'], ...extra,
  });
}
router.get('/quote/:token', wrap((req, res) => renderQuote(req, res)));
const answer = (fn, tab) => wrap(async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    res.status(e.status === 409 ? 409 : 422);
    return renderQuote(req, res, { errors: e.details || {}, old: req.body, tab, formError: e.details ? null : e.message });
  }
  return res.redirect(`/quote/${encodeURIComponent(req.params.token)}${tab === 'negotiate' ? '#conversation' : ''}`);
});
router.post('/quote/:token/accept', limiter, answer((req, res) => response.accept(req.params.token, req.body, { ip: req.ip, base: res.locals.baseUrl }), 'accept'));
router.post('/quote/:token/decline', limiter, answer((req, res) => response.decline(req.params.token, req.body, { base: res.locals.baseUrl }), 'decline'));
router.post('/quote/:token/negotiate', limiter, answer(async (req, res) => {
  await response.negotiate(req.params.token, req.body, { base: res.locals.baseUrl });
  flash(req, 'success', res.locals.t('sales.negotiation_sent'));
}, 'negotiate'));
/** The drawn signature of an accepted quotation (the link is the key). */
router.get('/quote/:token/signature.png', wrap(async (req, res) => {
  noIndex(res);
  const q = await sales.quoteByToken(req.params.token, { count: false });
  if (!q.signature || q.status !== 'accepted') return res.status(404).end();
  res.set({ 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': "default-src 'none'" });
  return res.end(q.signature);
}));

router.get('/invoice/:token', wrap(async (req, res) => {
  noIndex(res);
  const inv = await sales.invoiceByToken(req.params.token, { count: !isTeam(req) });
  const r = await sales.invoiceRecipient(inv.business_id);
  asLocale(req, res, r.locale);
  const pay = await require('../platformpay/platformpay.service').methods(); // eslint-disable-line global-require
  res.page('pages/sales/invoice-public', {
    layout: 'document', title: `${res.locals.t('sales.invoice')} ${inv.number || `#${inv.id}`}`, inv, p: await sales.profile(), pay,
    payResult: ['paid', 'pending', 'failed'].includes(req.query.pay) ? req.query.pay : null,
  });
}));
/** Pay the invoice by card from its link (no sign-in: the link is the key). */
router.post('/invoice/:token/pay', limiter, wrap(async (req, res) => {
  noIndex(res);
  const inv = await sales.invoiceByToken(req.params.token, { count: false });
  const back = `/invoice/${encodeURIComponent(req.params.token)}`;
  const r = await sales.invoiceRecipient(inv.business_id);
  try {
    const out = await require('../platformpay/platformpay.service').start('clinic', { // eslint-disable-line global-require
      businessId: inv.business_id, invoiceId: inv.id, userId: null, viaLink: true, baseUrl: require('../../middleware/web').publicBase(req), lang: res.locals.locale, // eslint-disable-line global-require
      customer: { name: inv.clinic_name, email: r.email || undefined },
    });
    return res.page('pages/platformpay/go', { layout: 'auth', title: res.locals.t('ppay.go_title'), ...out, back, noindex: true, pageScripts: ['/js/payments.js'] });
  } catch (e) {
    if (!e.code || (e.status >= 500 && e.code !== 'PAY_PROVIDER_ERROR' && e.code !== 'PAY_PROVIDER_UNREACHABLE')) throw e;
    const k = `ppay.err.${e.code}`;
    flash(req, 'error', res.locals.t(k) !== k ? res.locals.t(k) : res.locals.t('ppay.err.generic'));
    return res.redirect(back);
  }
}));

/** A document made from a template (its link): view, print or save as PDF. */
router.get('/document/:token', wrap(async (req, res) => {
  noIndex(res);
  const tpl = require('./templates.service'); // eslint-disable-line global-require
  const d = await tpl.documentByToken(req.params.token, { count: !isTeam(req) });
  asLocale(req, res, d.locale);
  res.page('pages/sales/document-public', { layout: 'document', title: d.title, d, html: tpl.render(d.body), p: await sales.profile() });
}));
/** A document's file — a Word file, or a PDF uploaded as a document (the link is the key). */
router.get('/document/:token/download', wrap(async (req, res) => {
  noIndex(res);
  const d = await require('./templates.service').documentByToken(req.params.token, { count: false, withFile: true }); // eslint-disable-line global-require
  if (!d.file) return res.redirect(`/document/${encodeURIComponent(req.params.token)}`);
  const t = require('./templates.service'); // eslint-disable-line global-require
  const pdf = t.isPdfName(d.filename);
  // A PDF opens in the browser (sandboxed: a PDF never runs the site's scripts); a Word file downloads.
  res.set({ 'Content-Type': t.mimeOfFile(d.filename), 'Content-Disposition': `${pdf && req.query.download !== '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.filename || 'document.docx')}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', ...(pdf ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}) });
  return res.end(d.file);
}));
/** A picture placed in a template (public: the documents that show it are sent to customers). */
router.get('/document-image/:token', wrap(async (req, res, next) => {
  const img = await require('./templates.service').imageByToken(req.params.token); // eslint-disable-line global-require
  if (!img) return next();
  res.set({ 'Content-Type': img.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'cross-origin' });
  return res.end(img.data);
}));

module.exports = router;
