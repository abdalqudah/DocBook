// Module gate for /app (worker: platformops). Mounted by src/routes/app.js right after the nav/badges middleware.
//  • works out which optional areas are off for the clinic (its own toggles + its subscription plan);
//  • rebuilds the menu without them (nav.forUser reads ctx.modulesOff);
//  • blocks their pages with a friendly 404 ("this section is turned off", with a link to the settings for managers);
//  • exposes moduleOn(key) and the invoice print template to every view (invoiceTpl), and the sample-data state
//    to the two pages that show the sample-data panel.
const { wrap } = require('../../routes/helpers');
const { isJson } = require('../../middleware/context');
const nav = require('../../routes/nav');
const ops = require('./ops.service');
const demo = require('./demo.service');

const DEMO_PAGES = [/^\/onboarding\/page\/?$/, /^\/settings\/data\/?$/];

module.exports = wrap(async (req, res, next) => {
  if (!req.business) return next();
  const st = await ops.state(req.business);
  req.ctx.modules = st.on;
  req.ctx.modulesOff = ops.hiddenNav(st.off);
  res.locals.moduleOn = (key) => !st.off.has(key);
  res.locals.navGroups = nav.forUser(req.ctx.permissions, req.ctx);
  res.locals.navActions = nav.actionsFor(req.ctx.permissions, req.ctx);
  res.locals.invoiceTpl = await ops.invoiceTemplate(req.ctx.businessId);
  if (req.method === 'GET' && DEMO_PAGES.some((re) => re.test(req.path))) res.locals.demoState = await demo.status(req.ctx.businessId);

  const key = ops.moduleForPath(req.path);
  if (!key || !st.off.has(key)) return next();
  res.status(404);
  if (isJson(req) || req.xhr) return res.json({ error: { code: 'MODULE_OFF', message: req.t('errors_platformops.MODULE_OFF') } });
  return res.page('pages/platformops/off', {
    title: req.t('modules_cfg.off_title'), moduleKey: key, notInPlan: st.notInPlan.has(key),
    manager: req.ctx.permissions.has('settings.manage'), pageStyles: ['/css/platformops.css'],
  });
});
