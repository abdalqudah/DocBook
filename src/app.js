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
  if (config.trustProxy) app.set('trust proxy', 1);
  app.engine('ejs', require('ejs').__express); // registered explicitly so the bundled build (npm run build) finds it
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

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
  app.get('/favicon.ico', (req, res) => res.redirect(301, brand.favicon || '/favicon.svg'));
  app.use('/', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0, index: false }));
  app.use('/hooks', require('./modules/messaging/hooks.web')); // WhatsApp / SMS provider webhooks: raw body, no session or CSRF
  app.use('/pay', require('./modules/payments/hooks.web')); // card gateway callback/return (PayTabs): raw body, no session or CSRF

  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(require('./middleware/domain').customDomain); // verified clinic domains serve the clinic page + booking

  app.use(session({
    name: 'db.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new ConnectSessionKnexStore({ knex, tableName: 'sessions', createTable: true, cleanupInterval: config.isTest ? 0 : 3_600_000 }),
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
      res.render(view, data, (err, body) => {
        if (err) return next(err);
        return res.render(`layouts/${layout}`, { ...data, body }, (err2, html) => (err2 ? next(err2) : res.send(html)));
      });
    };
    next();
  });

  app.use(loadUser);
  app.use(web.locals);
  // CSRF check; the booking-widget embed mode (frameable /<slug>/book?embed=1) uses a signed token instead of the session.
  app.use(require('./modules/discover/embed').wrapCsrf(web.csrf));

  app.get('/healthz', async (req, res) => {
    try { await knex.raw('select 1'); res.json({ status: 'ok' }); } catch { res.status(503).json({ status: 'db_unavailable' }); }
  });

  app.use('/', require('./routes/web'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
