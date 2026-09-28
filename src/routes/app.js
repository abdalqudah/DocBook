const express = require('express');
const { wrap } = require('./helpers');
const nav = require('./nav');
const theme = require('../modules/branding/theme');
const businesses = require('../modules/businesses/business.service');
const fin = require('../modules/finance/finance.data');
const alerts = require('../modules/budgets/alerts');
const verify = require('../modules/auth/verify.service');

const router = express.Router();

// Workspace theme override and logo (members only — this router is behind auth + membership).
router.get('/theme/:id.css', (req, res) => {
  if (Number(req.params.id) !== req.ctx.businessId) return res.status(404).end();
  res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'private, max-age=3600' });
  return res.send(theme.businessCss(req.business.color));
});
router.get('/logo/:id', wrap(async (req, res) => {
  if (Number(req.params.id) !== req.ctx.businessId) return res.status(404).end();
  const row = await businesses.logo(req.ctx.businessId);
  if (!row || !row.logo) return res.status(404).end();
  res.set({ 'Content-Type': row.logo_mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  return res.send(row.logo);
}));

// Navigation, badges and banners for every page.
router.use(wrap(async (req, res, next) => {
  const perms = req.ctx.permissions;
  res.locals.navGroups = nav.forUser(perms);
  res.locals.navActions = nav.actionsFor(perms);
  res.locals.verifyBanner = verify.required() && !verify.isVerified(req.user);
  const badges = { budgetAlerts: 0, pendingDeliveries: 0 };
  if (req.method === 'GET' && (perms.has('budgets.view') || perms.has('delivery.view'))) {
    const month = new Date().toISOString().slice(0, 7);
    const { data, budgetLines } = await fin.snapshot(req.ctx.businessId, month);
    if (perms.has('budgets.view')) {
      badges.budgetAlerts = budgetLines.filter((b) => b.isWarning || b.isExceeded).length;
      await alerts.sync(req.ctx.businessId, budgetLines, month, req.locale);
      res.locals.unreadNotifications = await require('../modules/notifications/notification.service').unreadCount(req.ctx); // eslint-disable-line global-require
    }
    if (perms.has('delivery.view')) badges.pendingDeliveries = data.deliveries.filter((d) => d.status === 'pending' || d.status === 'out_for_delivery').length;
  }
  res.locals.navBadges = badges;
  next();
}));

// New workspaces go through the setup wizard first (people who can manage settings only).
router.use((req, res, next) => {
  if (!req.business.onboarding_completed_at && req.ctx.permissions.has('settings.manage') && req.method === 'GET'
    && !req.path.startsWith('/onboarding') && !req.path.startsWith('/theme') && !req.path.startsWith('/logo') && !req.path.startsWith('/search')) {
    return res.redirect('/app/onboarding');
  }
  return next();
});

router.use('/onboarding', require('../modules/onboarding/web'));
router.use('/', require('../modules/dashboard/web'));
router.use('/search', require('../modules/search/web'));
router.use('/notifications', require('../modules/notifications/web'));
router.use('/partners', require('../modules/partners/web'));
router.use('/expenses', require('../modules/expenses/web'));
router.use('/payroll', require('../modules/payroll/web'));
router.use('/purchases', require('../modules/purchases/web'));
router.use('/sales', require('../modules/sales/web'));
router.use('/customers', require('../modules/sales/customers.web'));
router.use('/delivery', require('../modules/delivery/web'));
router.use('/marketing', require('../modules/marketing/web'));
router.use('/budgets', require('../modules/budgets/web'));
router.use('/reports', require('../modules/reports/web'));
router.use('/integrations/sheets', require('../modules/sheets/web'));
router.use('/advisor', require('../modules/ai/web'));
router.use('/support', require('../modules/support/web'));
router.use('/settings', require('../modules/settings/web'));

module.exports = router;
