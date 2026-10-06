const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const { ConnectSessionKnexStore } = require('connect-session-knex');

const config = require('./config');
const knex = require('./db/knex');
const theme = require('./modules/branding/theme');
const web = require('./middleware/web');
const { loadUser } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"], // no inline scripts anywhere
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"], // progress-bar widths only
        imgSrc: ["'self'", 'data:', 'https:'], // university / CMS images may live on an image CDN
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'", 'https://checkout.stripe.com'], // "Pay by card" continues on Stripe's hosted checkout
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  app.use(compression());

  app.get('/theme.css', async (req, res, next) => {
    try {
      const { css, etag } = await theme.css();
      res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=60', ETag: etag });
      if (req.get('if-none-match') === etag) return res.status(304).end();
      return res.send(css);
    } catch (e) { return next(e); }
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0, index: false }));
  app.use('/hooks', require('./modules/hooks.web')); // provider webhooks (raw body, signature-verified, no session)

  app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 2000 }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(session({
    name: 'gec.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new ConnectSessionKnexStore({ knex, tableName: 'sessions', createTable: true, cleanupInterval: config.isTest ? 0 : 3_600_000 }),
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd ? 'auto' : false, maxAge: config.security.sessionDays * 86_400_000 },
  }));

  // res.page(view, data): renders a page inside its layout (data.layout: public | staff | portal | auth | print).
  app.use((req, res, next) => {
    res.page = (view, data = {}) => res.render(view, data, (err, body) => {
      if (err) return next(err);
      return res.render(`layouts/${data.layout || 'public'}`, { ...data, body }, (e2, html) => (e2 ? next(e2) : res.send(html)));
    });
    next();
  });

  app.use(loadUser);
  app.use(web.locals);
  app.use(web.csrf);

  app.get('/healthz', async (req, res) => {
    try { await knex.raw('select 1'); res.json({ status: 'ok' }); } catch { res.status(503).json({ status: 'db_unavailable' }); }
  });

  app.use('/', require('./routes'));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
