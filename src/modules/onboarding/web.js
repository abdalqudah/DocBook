// Setup wizard for a new clinic (worker: owner). Seven short steps, each saved on its own:
//   clinic → hours → doctors → services → team → booking → done
// Every step can be skipped and revisited later (the home-page checklist links back here). The saved position is
// businesses.onboarding_step; reaching "done" (or "Finish later") marks the setup complete so /app opens normally.
// Business rules: ./setup.service.js.
const express = require('express');
const knex = require('../../db/knex');
const mailer = require('../../core/mailer');
const { E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const businesses = require('../businesses/business.service');
const { landingFor } = require('../auth/session');
const options = require('../settings/options');
const { takeStash, stash, baseUrl } = require('../settings/common');
const team = require('../settings/team.web');
const setup = require('./setup.service');
const { form } = require('./form');

const router = express.Router();
router.use(can('settings.manage'));

const { STEPS } = setup;
const go = (res, step) => res.redirect(`/app/onboarding/${step}`);
const PAGE_ASSETS = { pageStyles: ['/css/admin.css', '/css/ownerx.css'], pageScripts: ['/js/admin.js', '/js/ownerx.js'] };

async function stepData(req, step) {
  const b = req.ctx.businessId;
  switch (step) {
    case 'clinic': return {
      specialtyOptions: require('../platformops/clinic-types').options(req.t, req.business && req.business.specialty), // eslint-disable-line global-require
       currencyOptions: options.currencyOptions(req.t), zoneOptions: options.zoneOptions(req.locale),
      logoUrl: req.business.logo_mime ? `/app/logo/${b}?v=${req.business.logo_version || 0}` : null,
    };
    case 'hours': {
      const [week, n] = await Promise.all([setup.clinicHours(b), knex('doctors').where({ business_id: b }).count({ n: '*' }).first()]);
      return { hours: setup.hoursForm(week), week: setup.WEEK, doctorCount: Number(n.n) || 0 };
    }
    case 'doctors': {
      const [doctors, mine, week] = await Promise.all([
        setup.listDoctors(b), knex('memberships').where({ business_id: b, user_id: req.ctx.userId }).first('doctor_id'), setup.clinicHours(b),
      ]);
      return { doctors, ownerLinked: Boolean(mine && mine.doctor_id), hours: week ? setup.hoursForm(week) : null, slotChoices: setup.SLOT_CHOICES };
    }
    case 'services': {
      const [services, doctors] = await Promise.all([setup.listServices(b), knex('doctors').where({ business_id: b, is_active: true }).orderBy('full_name').select('id', 'full_name')]);
      const have = new Set(services.flatMap((s) => [s.name, s.name_en]).filter(Boolean).map((x) => String(x).trim().toLowerCase()));
      const suggested = setup.suggestions(req.business.specialty).map((s) => ({ ...s, label: req.locale === 'en' ? s.en : s.ar, added: have.has(s.ar.toLowerCase()) || have.has(s.en.toLowerCase()) }));
      return { services, doctors, suggested };
    }
    case 'team': {
      const [members, invitations, roles, doctors] = await Promise.all([
        businesses.listMembers(b), businesses.listInvitations(b), setup.staffRoles(b),
        knex('doctors as d').leftJoin('memberships as m', function onJoin() { this.on('m.doctor_id', 'd.id').andOn('m.business_id', 'd.business_id'); })
          .where({ 'd.business_id': b, 'd.is_active': true }).whereNull('m.id').orderBy('d.full_name').select('d.id', 'd.full_name'),
      ]);
      return { members, invitations, roles, freeDoctors: doctors, emailEnabled: mailer.configured(), result: takeStash(req, 'teamResult') };
    }
    case 'booking': {
      // A random address from sign-up (Arabic names can't make one) is replaced by a suggestion from the English name.
      const b0 = req.business;
      const random = !b0.slug || /^clinic-[0-9a-f]{4}$/.test(b0.slug);
      const suggestion = random && b0.name_en ? await businesses.suggestSlug(b0.name_en) : (b0.slug || await businesses.suggestSlug(b0.name));
      return { base: baseUrl(req), suggestion, publicUrl: b0.slug ? `${baseUrl(req)}/${b0.slug}` : null };
    }
    case 'done': {
      const [doctors, services, members, demo] = await Promise.all([
        knex('doctors').where({ business_id: b, is_active: true }).count({ n: '*' }).first(),
        knex('services').where({ business_id: b, is_active: true }).count({ n: '*' }).first(),
        knex('memberships').where({ business_id: b, status: 'active' }).count({ n: '*' }).first(),
        require('../platformops/demo.service').status(b), // eslint-disable-line global-require
      ]);
      return {
        summary: { doctors: Number(doctors.n), services: Number(services.n), team: Number(members.n) - 1, booking: Boolean(req.business.booking_enabled && req.business.slug) },
        publicUrl: req.business.slug ? `${baseUrl(req)}/${req.business.slug}` : null, demoState: demo,
      };
    }
    default: return {};
  }
}

async function renderStep(req, res, step, extra = {}) {
  const i = STEPS.indexOf(step);
  res.page(`pages/onboarding/${step}`, {
    layout: 'onboarding', title: req.t(`ownerx.wiz.title_${step}`), steps: STEPS, step, stepNo: i + 1, prev: STEPS[i - 1] || null, next: STEPS[i + 1] || null,
    b: req.business, completed: Boolean(req.business.onboarding_completed_at),
    reached: req.business.onboarding_completed_at ? STEPS.length : STEPS.indexOf(setup.stepOf(req.business.onboarding_step)), ...PAGE_ASSETS, ...(await stepData(req, step)), ...extra,
  });
}

/** Moves on after a step: saves the position, and on the last step marks the setup complete. */
async function moveOn(req, res, step) {
  const n = await setup.advance(req.ctx.businessId, req.business.onboarding_step, step);
  if (n === 'done') await setup.complete(req.ctx);
  return go(res, n);
}

router.get('/', (req, res) => go(res, req.business.onboarding_completed_at ? 'done' : setup.stepOf(req.business.onboarding_step)));
router.get('/region', (req, res) => go(res, 'clinic')); // earlier wizard: time zone & currency are now part of step 1
router.get('/page', (req, res) => go(res, 'booking'));
router.get('/finish', (req, res) => go(res, 'done'));

// ---------------------------------------------------------------- "Finish later" (top bar)
router.post('/finish', wrap(async (req, res) => {
  if (await setup.complete(req.ctx)) flash(req, 'info', req.t('ownerx.wiz.later_done'));
  res.redirect(await landingFor(req.ctx.userId, req.ctx.businessId));
}));

// ---------------------------------------------------------------- 1. clinic basics
router.post('/clinic', form(async (req, res) => {
  if (req.body._action !== 'skip') {
    const r = await setup.saveClinic(req.ctx, req.body);
    flash(req, 'success', req.t(r.logo ? 'ownerx.wiz.saved_logo' : 'ownerx.wiz.saved'));
  }
  return moveOn(req, res, 'clinic');
}, (req, res, extra) => renderStep(req, res, 'clinic', extra)));

// ---------------------------------------------------------------- 2. working days & hours
router.post('/hours', form(async (req, res) => {
  if (req.body._action !== 'skip') {
    const r = await setup.saveHours(req.ctx, req.body);
    flash(req, 'success', r.applied ? req.t('ownerx.wiz.hours_saved_n', { n: r.applied }) : req.t('ownerx.wiz.saved'));
  }
  return moveOn(req, res, 'hours');
}, (req, res, extra) => renderStep(req, res, 'hours', extra)));

// ---------------------------------------------------------------- 3. doctors
router.post('/doctors/add', can('doctors.manage'), form(async (req, res) => {
  await setup.addDoctor(req.ctx, req.body);
  flash(req, 'success', req.t('ownerx.wiz.doctor_added', { name: String(req.body.full_name || '').trim() }));
  res.redirect('/app/onboarding/doctors');
}, (req, res, extra) => renderStep(req, res, 'doctors', extra)));

// ---------------------------------------------------------------- 4. services
router.post('/services/pick', can('services.manage'), form(async (req, res) => {
  const r = await setup.saveSuggested(req.ctx, req.business.specialty, req.body, req.locale);
  if (r.added.length) flash(req, 'success', req.t('ownerx.wiz.services_added_n', { n: r.added.length }));
  if (r.skipped.length) flash(req, 'info', req.t('ownerx.wiz.services_skipped', { names: r.skipped.join('، ') }));
  res.redirect('/app/onboarding/services');
}, (req, res, extra) => renderStep(req, res, 'services', { ...extra, pickErrors: true })));

router.post('/services/add', can('services.manage'), form(async (req, res) => {
  await setup.addOwnService(req.ctx, req.body);
  flash(req, 'success', req.t('ownerx.wiz.service_added', { name: String(req.body.name || '').trim() }));
  res.redirect('/app/onboarding/services#own');
}, (req, res, extra) => renderStep(req, res, 'services', { ...extra, ownErrors: true })));

// ---------------------------------------------------------------- 5. staff logins (through the staff service)
router.post('/team/add', can('users.manage'), form(async (req, res) => {
  await setup.checkStaff(req.ctx, req.body);
  const result = await team.addLogin(req, { locale: req.locale, ...req.body });
  stash(req, 'teamResult', result);
  flash(req, 'success', req.t(`team.added_${result.type}`, { name: result.name }));
  res.redirect('/app/onboarding/team');
}, (req, res, extra) => renderStep(req, res, 'team', { ...extra, result: null })));

// ---------------------------------------------------------------- 6. booking page
router.post('/booking', form(async (req, res) => {
  if (req.body._action !== 'skip') await setup.saveBooking(req.ctx, req.business, req.body);
  return moveOn(req, res, 'booking');
}, (req, res, extra) => renderStep(req, res, 'booking', extra)));

// ---------------------------------------------------------------- 3. doctors: "Continue" needs one doctor
// Patients book with a doctor, so "Continue" without one explains why and stays; "Skip for now" still moves on.
router.post('/doctors', wrap(async (req, res, next) => {
  if (req.body._action === 'skip') return next();
  const one = await knex('doctors').where({ business_id: req.ctx.businessId, is_active: true }).first('id');
  if (one) return next();
  res.status(422);
  return renderStep(req, res, 'doctors', { needDoctor: true });
}));

// ---------------------------------------------------------------- steps with nothing to save ("Continue" / "Skip")
router.post('/:step(doctors|services|team)', wrap((req, res) => moveOn(req, res, req.params.step)));

// ---------------------------------------------------------------- step pages
router.get('/:step', wrap(async (req, res) => {
  const { step } = req.params;
  if (!STEPS.includes(step)) return go(res, 'clinic');
  // Arriving at the last step finishes the setup (so the rest of the app opens), even when steps were skipped.
  if (step === 'done' && !req.business.onboarding_completed_at) {
    await setup.complete(req.ctx);
    req.business = await businesses.get(req.ctx.businessId);
  }
  return renderStep(req, res, step);
}));
router.get('/:step/:action', (req, res) => go(res, STEPS.includes(req.params.step) ? req.params.step : 'clinic')); // e.g. a reload after a form error
router.post('/:step', (req, res, next) => next(E.notFound('Step')));

module.exports = router;
