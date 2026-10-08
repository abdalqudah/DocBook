const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const { ConnectSessionKnexStore } = require('connect-session-knex');

const config = require('./config');
const brand = require('./config/brand');
const knex = require('./db/knex');
const theme = require('./modules/branding/theme');
const { loadUser } = require('./middleware/context');
const web = require('./middleware/web');
const { notFound, errorHandler } = require('./middleware/errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.engine('ejs', require('ejs').__express); // registered explicitly so the bundled build (npm run build) finds it
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Every request has a database context (src/db/tenant.js): the main database until its clinic is known.
  app.use((req, res, next) => require('./db/tenant').als.run({ req: true }, next)); // eslint-disable-line global-require
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"], // widths of meters/bars only; scripts stay strict
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());

  // ---- Brand assets generated from src/config/brand.js
  app.get('/theme.css', (req, res) => {
    res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=300', ETag: theme.etag });
    res.send(theme.css);
  });
  app.get('/favicon.svg', (req, res) => {
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.send(theme.markSvg());
  });
  app.use('/', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0, index: false }));
  app.use('/hooks', require('./modules/messaging/hooks.web')); // WhatsApp / SMS provider webhooks: raw body, no session or CSRF
  app.use('/pay', require('./modules/payments/hooks.web')); // card gateway callback/return (PayTabs): raw body, no session or CSRF

  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(require('./middleware/domain').customDomain); // verified clinic domains serve the clinic page + booking
  app.use(require('./middleware/edition').route); // one clinic / one centre: its website at /, its management at /admin

  app.use(session({
    name: 'db.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new ConnectSessionKnexStore({ knex: knex.main, tableName: 'sessions', // sign-in sessions live in the main database
      createTable: true, cleanupInterval: config.isTest ? 0 : 3_600_000 }),
    // 'auto': Secure over HTTPS (behind a trusted proxy too); still works when a clinic runs DocBook over plain http
    // on its local network — otherwise phones could never stay signed in there (e.g. attendance QR scans).
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd ? 'auto' : false, maxAge: 14 * 86_400_000 },
  }));

  // Render a view inside a layout: res.page('pages/x', { layout: 'app', ... }).
  app.use((req, res, next) => {
    res.page = (view, data = {}) => {
      const print = data.printable && req.query.print === '1';
      const layout = print ? 'print' : data.layout || 'app';
      for (const k of ['dir', 'locale', 't', 'theme', 'csrfToken', 'currentUser']) if (k in data && k in res.locals) delete data[k];
      const draw = () => res.render(view, data, (err, body) => {
        if (err) return next(err);
        return res.render(`layouts/${layout}`, { ...data, body }, (err2, html) => (err2 ? next(err2) : res.send(html)));
      });
      // A clinic's public page (booking, a doctor, reviews, a shared document…): its website's header, logo, footer
      // and colours, like its home page.
      // Printed papers share one letterhead, set in the invoice template (logo, name, contact, logo size).
      const biz = res.locals.business;
      if (layout === 'print' && biz && biz.id && !data.invoiceTpl && !res.locals.invoiceTpl) {
        return require('./modules/platformops/ops.service').invoiceTemplate(biz.id).then((tpl) => { // eslint-disable-line global-require
          res.locals.invoiceTpl = tpl; draw();
        }).catch(next);
      }
      const c = data.clinic;
      if (layout === 'public' && c && c.id && c.slug && !data.wsSite && !res.locals.wsSite && !data.embedMode && !res.locals.embedMode) {
        return require('./modules/site/portal.web').siteChromeFor(req, res, c).then((look) => { // eslint-disable-line global-require
          if (look.bodyClass) {
            const own = (data.pageStyles || []).filter((h) => h !== '/css/site.css' && !h.endsWith('/theme.css'));
            data.pageStyles = [...look.styles, ...own];
            data.bodyClass = [data.bodyClass, look.bodyClass].filter(Boolean).join(' ');
          }
          draw();
        }).catch(next);
      }
      return draw();
    };
    next();
  });

  app.use(loadUser);
  app.use(require('./modules/platformops/clinic-types').middleware); // clinic types managed by the platform admin
  app.use(web.locals);
  const branding = require('./modules/platformops/branding');
  app.use(branding.middleware); // the platform admin's logo / icon over the built-in brand
  app.use(require('./modules/platformops/loginpage').middleware); // the sign-in page's own words, look and (one clinic) colours
  app.get('/brand/:key', (req, res, next) => Promise.resolve(branding.serve(req, res, next)).catch(next));
  // /favicon.ico — what a browser asks for on a page with no icon of its own (a file opened from the patient's file: a
  // PDF, an image). A clinic's own address (its domain / the one-clinic edition) was turned into its icon above; else
  // the signed-in member's clinic icon, else the platform's. Never a permanent redirect: the answer depends on who asks.
  app.get('/favicon.ico', (req, res, next) => Promise.resolve((async () => {
    const id = req.user && req.user.last_business_id;
    const f = id ? await require('./modules/businesses/business.service').faviconFile(id).catch(() => null) : null; // eslint-disable-line global-require
    if (!f) return res.redirect(302, (res.locals.brand && res.locals.brand.favicon) || brand.favicon || '/favicon.svg');
    res.set(require('./core/images').headers(f.mime, 'private, max-age=3600')); // eslint-disable-line global-require
    res.set('Vary', 'Cookie');
    return res.send(f.data);
  })()).catch(next));
  // CSRF check; the booking-widget embed mode (frameable /<slug>/book?embed=1) uses a signed token instead of the session.
  app.use(require('./modules/discover/embed').wrapCsrf(web.csrf));

  app.get('/healthz', async (req, res) => {
    try { await knex.raw('select 1'); res.json({ status: 'ok' }); } catch { res.status(503).json({ status: 'db_unavailable' }); }
  });

  app.use(require('./modules/platformops/maintenance').middleware); // closed for maintenance (the platform admin still gets through)
  app.use('/', require('./routes/web'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
