// The clinic's colours and browser icon for the full-screen pages opened by a secret link (waiting-room TV
// /queue/<token>, attendance door screen /kiosk/<token>): no staff session there, so the screen serves both itself.
//   addRoutes(router, screenOf)  → GET /:token/theme.css and GET /:token/favicon
//   locals(base, clinic)         → { themeHref, faviconHref } for res.page
const { wrap } = require('../routes/helpers');

function addRoutes(router, screenOf) {
  router.get('/:token/theme.css', wrap(async (req, res) => {
    const s = await screenOf(req.params.token);
    if (!s) return res.status(404).end();
    res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'X-Robots-Tag': 'noindex' });
    return res.send(await require('../modules/site/portal.web').clinicThemeCss(s.b)); // eslint-disable-line global-require
  }));
  router.get('/:token/favicon', wrap(async (req, res) => {
    const s = await screenOf(req.params.token);
    const f = s && await require('../modules/businesses/business.service').faviconFile(s.b.id); // eslint-disable-line global-require
    if (!f) return res.redirect(302, '/favicon.svg');
    res.set(require('./images').headers(f.mime, 'private, max-age=86400')); // eslint-disable-line global-require
    return res.send(f.data);
  }));
}

const locals = (base, clinic) => ({
  themeHref: `${base}/theme.css?v=${encodeURIComponent(String(clinic.color || ''))}-${Number(clinic.logo_version || 0)}`,
  faviconHref: `${base}/favicon?v=${Number(clinic.favicon_version || 0)}-${Number(clinic.logo_version || 0)}`,
});

module.exports = { addRoutes, locals };
