const { AppError } = require('../core/errors');
const config = require('../config');

function notFound(req, res, next) {
  next(new AppError('NOT_FOUND', 'Page not found.', 404));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const known = err instanceof AppError;
  const status = known ? err.status : 500;
  if (!known && !config.isTest) console.error(`[error] ${req.method} ${req.originalUrl}`, err); // eslint-disable-line no-console
  const code = known ? err.code : 'INTERNAL_ERROR';
  const message = known ? err.message : 'Something went wrong. Please try again.';
  const t = res.locals.t || ((k) => k);
  const translated = t(`errors.${code}`);
  const shown = translated !== `errors.${code}` ? translated : message;

  if (req.originalUrl.startsWith('/api/') || (req.get('accept') || '').startsWith('application/json')) {
    return res.status(status).json({ success: false, error: { code, message: shown, ...(err.details ? { details: err.details } : {}) } });
  }
  if (code === 'UNAUTHENTICATED') return res.redirect('/login');
  if (code === 'CSRF_TOKEN_INVALID' && req.session) {
    req.session.flash = [{ type: 'error', message: shown }];
    return res.redirect(req.get('referer') || '/');
  }
  res.status(status);
  const layout = req.ctx?.businessId && res.locals.business ? 'app' : 'public';
  const data = {
    layout,
    title: status === 404 ? t('errors.not_found_title') : status === 403 ? t('errors.forbidden_title') : t('errors.generic_title'),
    status, code, message: shown,
    stack: !config.isProd && !known ? err.stack : null,
  };
  if (!res.locals.t) return res.type('text').send(`${status} ${message}`);
  return res.render('pages/error', data, (e1, body) => {
    if (e1) return res.type('text').send(`${status} ${message}`);
    return res.render(`layouts/${layout}`, { ...data, body }, (e2, html) => (e2 ? res.type('text').send(`${status} ${message}`) : res.send(html)));
  });
}

module.exports = { notFound, errorHandler };
