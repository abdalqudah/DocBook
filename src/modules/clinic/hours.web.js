// Clinic → Working hours (/app/clinic/hours): the clinic's usual week, the same editor as setup step 2. Saving it
// updates the doctors who follow the clinic's week (or every doctor when asked) — onboarding/setup.service.saveHours.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const setup = require('../onboarding/setup.service');

const router = express.Router();
router.use(can('settings.manage'));
const ASSETS = { pageStyles: ['/css/admin.css', '/css/ownerx.css'], pageScripts: ['/js/admin.js', '/js/ownerx.js'] };

async function render(req, res, extra = {}) {
  const b = req.ctx.businessId;
  const [week, n] = await Promise.all([setup.clinicHours(b), knex('doctors').where({ business_id: b }).count({ n: '*' }).first()]);
  res.page('pages/clinic/hours', { title: req.t('clinic_hours.title'), hours: setup.hoursForm(week), week: setup.WEEK, doctorCount: Number(n.n) || 0, old: {}, errors: {}, formError: null, ...ASSETS, ...extra });
}

router.get('/', wrap((req, res) => render(req, res)));
router.post('/', form(async (req, res) => {
  const r = await setup.saveHours(req.ctx, req.body);
  flash(req, 'success', r.applied ? req.t('ownerx.wiz.hours_saved_n', { n: r.applied }) : req.t('ownerx.wiz.saved'));
  res.redirect('/app/clinic/hours');
}, (req, res, extra) => render(req, res, extra)));

module.exports = router;
