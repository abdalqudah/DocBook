// Short addresses for the website that owns the domain — the clinic (or centre) of a one-clinic / one-centre
// installation, or a clinic on its own connected domain:
//   /about  /services  /gallery …   a page of the website   (internally /<slug>/p/<page>)
//   /doctors  /doctors/<name>       the doctors, a doctor   (internally /<slug>/doctors…)
//   /book  /articles                booking, the articles   (internally /<slug>/…)
//   /login                          the staff sign-in (the installation's own; a clinic domain sends it to DocBook's)
// Links in the pages are written in that short form, and the long ones (/<slug>/p/about…) answer with a permanent
// redirect to it. Other clinics (a centre's doctors) keep their /<their address>/… pages.
const cache = require('../../core/cache');

// Addresses of the system itself: a website page never takes one of these over.
const SYSTEM = new Set(('app admin api hooks m pay brand favicon healthz theme ads ad-image assets auth blog clinics features forgot invite '
  + 'login logo logo-square logout media password preferences pricing r reset return signup verify verify-email workspaces css js img '
  + 'c d share kiosk telehealth vendor vendors marketplace join reps staff enter p fonts book doctors articles').split(' '));

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rewrites the long addresses of `slug` in a page (links, forms, canonical / JSON-LD addresses) to the short ones. */
function shorten(text, slug) {
  if (!slug || typeof text !== 'string' || !text.includes(`/${slug}`)) return text;
  // Only an address that starts a link: after a quote, a space, "(", "=", "," or after "//host" (absolute URLs).
  // Never inside another path (/m/<slug>/… pictures stay as they are).
  const at = '(?<=["\'(\\s=,]|//[^/"\'\\s<>]{1,253})';
  const s = esc(slug);
  return text
    .replace(new RegExp(`${at}/${s}/p/(?=[a-z0-9-])`, 'g'), '/')
    .replace(new RegExp(`${at}/${s}/(?=(?:book|doctors|articles|login|llms\\.txt)(?:[/"'?#\\s<\\\\&]|$))`, 'g'), '/')
    .replace(new RegExp(`${at}/${s}(?=["'?#\\s<\\\\])`, 'g'), '/');
}

/** The long form of a short path for `slug`, or null when the path is not one of the website's short addresses. */
async function longPath(slug, path, pageSlugs) {
  if (path === '/doctors' || path === '/doctors/') return `/${slug}/doctors`;
  const m = /^\/([a-z0-9-]{1,40})\/?$/.exec(path);
  if (m && !SYSTEM.has(m[1]) && (await pageSlugs(slug)).includes(m[1])) return `/${slug}/p/${m[1]}`;
  return null;
}

/** The address of every extra page of a clinic's published website (cached briefly). */
function pageSlugs(slug) {
  return cache.remember(`site:pageslugs:${slug}`, async () => {
    const knex = require('../../db/knex'); // eslint-disable-line global-require
    const b = await knex.main('businesses').where({ slug }).whereNot('status', 'deleted').first('id');
    if (!b) return [];
    const st = await require('../website/site.service').publicState(b.id); // eslint-disable-line global-require
    return st && st.status === 'live' && st.doc ? st.doc.pages.filter((p) => p.key !== 'home' && p.slug).map((p) => p.slug) : [];
  }, 30_000);
}

/** A long address of the root website → its short form (for a permanent redirect), else null. */
function shortOf(slug, path) {
  if (path.startsWith(`/${slug}/p/`)) return `/${path.slice(slug.length + 4)}`;
  const m = new RegExp(`^/${esc(slug)}(/(?:book|doctors|articles)(?:/.*)?|/login)$`).exec(path);
  return m ? m[1] : null;
}

/**
 * Serves the root website at short addresses: resolves them, sends old long ones to the short form and writes every
 * link of the answer in the short form. Call with the slug that owns the domain's root.
 */
async function serve(req, res, slug) {
  const p = req.path;
  const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (isRead) {
    const short = shortOf(slug, p);
    if (short) { res.redirect(301, `${short}${q}`); return 'done'; }
  }
  res.locals.rootSlug = slug;
  const send = res.send.bind(res);
  res.send = (body) => {
    const type = String(res.get('Content-Type') || '');
    if (typeof body === 'string' && (!type || /html|xml|text\/plain|json/.test(type))) body = shorten(body, slug);
    return send(body);
  };
  const redirect = res.redirect.bind(res);
  res.redirect = (a, b) => (typeof a === 'number' ? redirect(a, shorten(` ${b}`, slug).slice(1)) : redirect(shorten(` ${a}`, slug).slice(1)));
  const long = isRead || req.method === 'POST' ? await longPath(slug, p, pageSlugs) : null;
  if (long) { req.url = `${long}${q}`; return 'rewritten'; }
  return null;
}

module.exports = { SYSTEM, shorten, shortOf, longPath, pageSlugs, serve };
