const { AppError } = require('../core/errors');
const { translateMessage } = require('../core/i18n');
const config = require('../config');
const { wantsJson } = require('./auth');

/** The referring page when it is on this site, else the home page (never an open redirect). */
function safeBack(req, fallback = '/') {
  const back = req.get('referer');
  try { if (back && new URL(back).host === req.get('host')) { const u = new URL(back); return u.pathname + u.search; } } catch { /* bad referer */ }
  return fallback;
}

function notFound(req, res, next) {
  next(new AppError('NOT_FOUND', 'Page not found.', 404));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const known = err instanceof AppError;
  const status = known ? err.status : 500;
  if (!known && !config.isTest) console.error(`[error] ${req.method} ${req.originalUrl}`, err); // eslint-disable-line no-console
  const code = known ? err.code : 'INTERNAL_ERROR';
  const t = res.locals.t || ((k) => k);
  const translated = t(`errors.${code}`, err.details || {});
  const message = translated !== `errors.${code}` ? translated : (known ? err.message : 'Something went wrong. Please try again.');
  const locale = req.locale || 'en';
  const details = err.details && code === 'VALIDATION_FAILED'
    ? Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k, translateMessage(locale, v)])) : err.details;

  if (wantsJson(req)) return res.status(status).json({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
  if (code === 'UNAUTHENTICATED') return res.redirect(req.originalUrl.startsWith('/staff') ? '/staff/login' : '/login');
  const BACK = ['CSRF_TOKEN_INVALID', 'VALIDATION_FAILED', 'UPLOAD_TYPE', 'UPLOAD_MISSING', 'UPLOAD_FAILED', 'APPLICATION_EXISTS', 'SYSTEM_ROLE', 'ROLE_IN_USE', 'NOT_CONFIGURED'];
  if (BACK.includes(code) && req.session && req.method !== 'GET') {
    // A form error goes back to the form with the message (forms that render their own errors catch them first).
    req.session.flash = [...(req.session.flash || []), { type: 'error', message: code === 'VALIDATION_FAILED' && details ? `${message} ${Object.values(details).join(' · ')}` : message }];
    return res.redirect(safeBack(req));
  }
  res.status(status);
  if (!res.locals.t) return res.type('text').send(`${status} ${message}`);
  const layout = req.staff && req.originalUrl.startsWith('/staff') ? 'staff' : (req.originalUrl.startsWith('/portal') ? 'portal' : 'public');
  return res.render('pages/error', { status, code, message, stack: !config.isProd && !known ? err.stack : null }, (e1, body) => {
    if (e1) return res.type('text').send(`${status} ${message}`);
    return res.render(`layouts/${layout}`, { title: message, body }, (e2, html) => (e2 ? res.type('text').send(`${status} ${message}`) : res.send(html)));
  });
}

module.exports = { notFound, errorHandler, safeBack };
