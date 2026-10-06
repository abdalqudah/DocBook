// The staff workspace (/staff): shell locals, dashboard, palette API, and each module's routes.
const express = require('express');
const { requireStaff, can } = require('../../middleware/auth');
const { ah, ok } = require('../../core/http');
const nav = require('./nav');
const registry = require('./registry');

const router = express.Router();
router.use(requireStaff);
router.use((req, res, next) => {
  res.locals.nav = nav.forStaff(req);
  res.locals.quickNew = registry.actionsFor(req);
  res.locals.sidebarMini = req.cookies && req.cookies.gec_sb === 'mini';
  next();
});

router.get('/', can('dashboard.view'), ah(require('./dashboard').page));

// Command palette: actions first (filtered by the query), then search results from every module.
router.get('/api/palette', ah(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const t = req.t;
  const acts = registry.actionsFor(req).map((a) => ({ title: t(`quick.${a.key}`), href: a.href, icon: a.icon }))
    .filter((a) => !q || a.title.toLowerCase().includes(q.toLowerCase()));
  const groups = [];
  if (q.length >= 2) {
    const found = await Promise.all(registry.search.map((fn) => fn(req, q).catch(() => null)));
    found.filter((g) => g && g.items.length).forEach((g) => groups.push(g));
  }
  const pages = res.locals.nav.flatMap((g) => g.items).map((i) => ({ title: t(`nav.${i.key}`), href: i.href, icon: i.icon }))
    .filter((p) => q && p.title.toLowerCase().includes(q.toLowerCase())).slice(0, 5);
  ok(res, { groups: [...groups, { key: 'pages', label: t('palette.pages'), items: pages }, { key: 'actions', label: t('palette.actions'), items: acts.slice(0, q ? 6 : 8) }] });
}));

router.use('/account', require('./account.web'));
router.use('/', require('../crm/web'));
router.use('/', require('../team/web'));
router.use('/', require('../catalog/admin').router);
router.use('/', require('../catalog/staff.web'));
router.use('/', require('../admissions/web'));
router.use('/', require('../booking/web'));
router.use('/settings', require('../settings/web'));
router.use('/settings/pipeline', require('../settings/pipelines.web'));
router.use('/roles', require('../rbac/web'));
router.use('/audit', require('../audit/web'));

module.exports = router;
