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
  const badges = { waiting: 0, pendingAdjustments: 0, lowStock: 0, toPay: 0, newOffers: 0, repRequests: 0 };
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
    if (perms.has('vendors.view')) {
      // Reps & warehouses: offers for this clinic's specialty not opened yet, and rep visit requests awaiting a decision.
      badges.newOffers = await require('../modules/marketplace/market.service').newOffersCount({ businessId: b, today: req.ctx.today }, req.business); // eslint-disable-line global-require
      const rq = knex('rep_visits').where({ business_id: b, status: 'requested' }).where('visit_date', '>=', req.ctx.today);
      if (req.ctx.ownDoctorId) rq.where('doctor_id', req.ctx.ownDoctorId);
      const [{ n }] = await rq.count({ n: '*' });
      badges.repRequests = Number(n);
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

router.use(require('../modules/subscriptions/enforce')); // trial / plan gate (off unless the platform enables subscriptions)
router.use(require('../modules/platformops/gate'));
router.use(require('../modules/teamops/presence.service').middleware); // "last seen" on every page load // clinic modules on/off: hides their menu items and blocks their pages
router.use('/onboarding', require('../modules/onboarding/web'));
router.use('/api', require('../modules/clinic/api.web'));
router.use('/search', require('../modules/clinic/search.web'));
router.use('/notifications', require('../modules/notifications/web'));
router.use('/', require('../modules/clinic/dashboard.web'));
router.use('/appointments', require('../modules/clinic/appointments.web'));
router.use('/front-desk', require('../modules/clinic/frontdesk.web'));
router.use('/patients', require('../modules/clinic/patients.web'));
router.use(require('../modules/certificates/web')); // /certificates + the visit page's "Documents" panel data (before /visits)
router.use('/', require('../modules/clinicalplus/web')); // ICD-10 codes, consultation timer, record privacy + access log
router.use('/', require('../modules/specialty/web')); // dental chart, child growth, pregnancy follow-up
router.use('/', require('../modules/ai/web')); // AI clinical assistant
router.use('/visits', require('../modules/patientdocs/visit-hook')); // data for the "Documents for the patient" panel
router.use('/visits', require('../modules/clinic/visits.web'));
router.use('/patient-docs', require('../modules/patientdocs/web')); // prescription / report PDFs, send to patient
router.use('/payments', require('../modules/payments/staff.web')); // online card payments, refunds
router.use('/telehealth', require('../modules/telehealth/web'));
router.use('/cashier', require('../modules/clinic/cashier.web'));
router.use('/billing', require('../modules/clinic/billing.web'));
router.use(require('../modules/finance/hooks')); // budget checks right after expenses / doctor pay are saved
router.use('/payroll', require('../modules/clinic/payroll.web'));
router.use('/expenses', require('../modules/expenses/web'));
router.use('/doctors', require('../modules/clinic/doctors.web'));
router.use('/services', require('../modules/clinic/services.web'));
router.use('/supplies/orders', require('../modules/purchasing/web'));
router.use('/supplies', require('../modules/clinic/supplies.web'));
router.use('/marketplace', require('../modules/marketplace/web'));
router.use('/rep-visits', require('../modules/marketplace/rep-visits.web'));
router.use('/', require('../modules/discover/app.web')); // /settings/booking-links, /reports/bookings
router.use('/reports', require('../modules/clinic/reports.web'));
router.use('/reviews', require('../modules/reviews/web')); // verified patient reviews
router.use('/messaging', require('../modules/messaging/staff.web')); // WhatsApp click-to-chat for staff
router.use('/settings/messaging', require('../modules/messaging/web')); // Settings → Messaging (reminders, channels, log)
router.use('/attendance', require('../modules/attendance/web'));
router.use('/settings/database', require('../modules/datasync/web'));
router.use('/help', require('../modules/support/web'));
router.use('/', require('../modules/finance/web')); // staff payroll, partners, budgets, profit & loss
router.use('/', require('../modules/ai/finance.web')); // AI finance assistant
router.use('/', require('../modules/teamops/web')); // support tickets, presence, notification settings, doctor e-mails
router.use('/', require('../modules/platformops/web')); // modules on/off, invoice template, service categories, demo data
router.use('/', require('../modules/integrations/web')); // Google Sheets sync, media library
router.use('/', require('../modules/live/web')); // live agenda events + calendar import
router.use('/', require('../modules/signatures/web')); // doctor signatures + clinic stamp
router.use('/', require('../modules/subscriptions/web')); // Settings → Subscription
router.use('/settings/payments', require('../modules/payments/settings.web')); // Settings → Online payments
router.use('/settings', require('../modules/settings/web'));

module.exports = router;
