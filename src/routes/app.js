const express = require('express');
const knex = require('../db/knex');
const { wrap } = require('./helpers');
const nav = require('./nav');
const theme = require('../modules/branding/theme');
const businesses = require('../modules/businesses/business.service');
const verify = require('../modules/auth/verify.service');
const { clinicNow } = require('../modules/clinic/scheduling');

const router = express.Router();

// Clinic theme override and logo (members only — this router is behind auth + membership).
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
  req.ctx.today = clinicNow(req.business.timezone).date;
  res.locals.clinicToday = req.ctx.today;
  res.locals.navGroups = nav.forUser(perms, req.ctx);
  res.locals.navActions = nav.actionsFor(perms);
  res.locals.verifyBanner = verify.required() && !verify.isVerified(req.user);
  res.locals.ctx = req.ctx;
  const badges = { waiting: 0, pendingAdjustments: 0, lowStock: 0, toPay: 0 };
  if (req.method === 'GET' && !req.path.startsWith('/theme') && !req.path.startsWith('/logo')) {
    const b = req.ctx.businessId;
    if (perms.has('frontdesk.use')) {
      const [{ n }] = await knex('appointments').where({ business_id: b, appointment_date: req.ctx.today, checked_in: true, with_doctor: false, payment_status: 'unpaid' }).whereNot('status', 'cancelled').count({ n: '*' });
      badges.waiting = Number(n);
    }
    if (perms.has('billing.manage')) {
      // Visits of today waiting at the cashier: arrived (or finished) and not yet paid.
      const [{ n }] = await knex('appointments').where({ business_id: b, appointment_date: req.ctx.today, payment_status: 'unpaid' }).whereNot('status', 'cancelled')
        .whereNot('appointment_type', 'blocked').andWhere((q) => q.where('checked_in', true).orWhere('status', 'completed')).count({ n: '*' });
      badges.toPay = Number(n);
    }
    if (perms.has('payroll.approve')) {
      const [{ n }] = await knex('payroll_adjustments').where({ business_id: b, approval_status: 'pending' }).count({ n: '*' });
      badges.pendingAdjustments = Number(n);
    }
    if (perms.has('supplies.view')) {
      const [{ n }] = await knex('supply_items').where({ business_id: b }).whereRaw('current_stock <= reorder_level').count({ n: '*' });
      badges.lowStock = Number(n);
    }
  }
  res.locals.navBadges = badges;
  next();
}));

// New clinics go through the setup wizard first (people who can manage settings only).
router.use((req, res, next) => {
  if (!req.business.onboarding_completed_at && req.ctx.permissions.has('settings.manage') && req.method === 'GET'
    && !['/onboarding', '/theme', '/logo', '/search', '/api'].some((p) => req.path.startsWith(p))) {
    return res.redirect('/app/onboarding');
  }
  return next();
});

router.use('/onboarding', require('../modules/onboarding/web'));
router.use('/api', require('../modules/clinic/api.web'));
router.use('/search', require('../modules/clinic/search.web'));
router.use('/notifications', require('../modules/notifications/web'));
router.use('/', require('../modules/clinic/dashboard.web'));
router.use('/appointments', require('../modules/clinic/appointments.web'));
router.use('/front-desk', require('../modules/clinic/frontdesk.web'));
router.use('/patients', require('../modules/clinic/patients.web'));
router.use('/visits', require('../modules/clinic/visits.web'));
router.use('/cashier', require('../modules/clinic/cashier.web'));
router.use('/billing', require('../modules/clinic/billing.web'));
router.use('/payroll', require('../modules/clinic/payroll.web'));
router.use('/expenses', require('../modules/expenses/web'));
router.use('/doctors', require('../modules/clinic/doctors.web'));
router.use('/services', require('../modules/clinic/services.web'));
router.use('/supplies', require('../modules/clinic/supplies.web'));
router.use('/reports', require('../modules/clinic/reports.web'));
router.use('/help', require('../modules/support/web'));
router.use('/settings', require('../modules/settings/web'));

module.exports = router;
