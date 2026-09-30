// Per-member page access gate for /app (worker: access). Mounted in src/routes/app.js right after the platformops gate.
//  • hides the pages this member may not open (their own denials + pages opened only as a side effect of an allow)
//    from the menu, the section tabs, the ⌘K palette and the quick actions — through ctx.modulesOff, which nav.forUser reads;
//  • blocks their addresses (the page's href and everything under it; the longest href wins, so a page never swallows
//    another page that lives under its address) with a friendly 403;
//  • the member's landing page (their role's entry page, or /app) redirects to the first page they can open instead.
const { wrap } = require('../../routes/helpers');
const { isJson } = require('../../middleware/context');
const nav = require('../../routes/nav');
const { entryFor } = require('../rbac/permissions');
const access = require('./access.service');

module.exports = wrap(async (req, res, next) => {
  const perms = req.ctx && req.ctx.permissions;
  const off = perms && perms.pagesOff;
  if (!off || !off.size) return next();
  req.ctx.clinicModulesOff = req.ctx.modulesOff || new Set();
  req.ctx.modulesOff = new Set([...req.ctx.clinicModulesOff, ...off]);
  const blocked = (href) => { const p = access.pageForPath(href); return Boolean(p && off.has(p.key)); };
  res.locals.navGroups = nav.forUser(perms, req.ctx);
  res.locals.navActions = nav.actionsFor(perms, req.ctx).filter((a) => !blocked(a.href));

  const full = `${req.baseUrl || ''}${req.path}`.replace(/(.)\/+$/, '$1');
  const page = access.pageForPath(full);
  if (!page || !off.has(page.key)) return next();
  const first = (res.locals.navGroups.flatMap((g) => g.items)[0] || { href: '/app/settings' }).href;
  if (req.method === 'GET' && (full === '/app' || full === entryFor(req.ctx.roleKey)) && first !== full && !isJson(req)) return res.redirect(first);
  res.status(403);
  if (isJson(req) || req.xhr) return res.json({ success: false, error: { code: 'PAGE_ACCESS_DENIED', message: req.t('errors_access.PAGE_ACCESS_DENIED') } });
  return res.page('pages/access/blocked', { title: req.t('access.blocked_title'), pageLabel: req.t(page.label), home: first, pageStyles: ['/css/access.css'] });
});
