const { AppError } = require('../core/errors');
const config = require('../config');

function notFound(req, res, next) {
  next(new AppError('NOT_FOUND', 'Page not found.', 404));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // A table or column of this version is missing (an update whose database changes have not run yet): bring the
  // database up to date now and ask the visitor to reload, instead of a server error.
  const auto = require('../db/auto'); // eslint-disable-line global-require
  if (auto.isMissingSchema(err) && config.autoMigrate && !config.isTest) {
    auto.ensureLatest({ reason: 'missing table/column' }).catch((e) => console.error('[db] update failed:', e.message)); // eslint-disable-line no-console
    res.set({ 'Retry-After': '5', 'Cache-Control': 'no-store' });
    if ((req.get('accept') || '').startsWith('application/json')) return res.status(503).json({ success: false, error: { code: 'UPDATING', message: 'Updating the database, try again in a few seconds.' } });
    return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><body style="font-family:Tahoma,Arial,sans-serif;max-width:520px;margin:15vh auto;text-align:center"><p dir="rtl" lang="ar">جاري تحديث قاعدة البيانات… ستتحدث الصفحة تلقائيًا.</p><p>Updating the database… this page refreshes by itself.</p></body>');
  }
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
