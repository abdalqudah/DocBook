// Setup wizard for a new clinic: details → region → doctors → services → staff logins → clinic page, then /app.
// Every step can be skipped; progress is saved in businesses.onboarding_step.
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const businesses = require('../businesses/business.service');
const rbac = require('../rbac/rbac.service');
const doctorsSvc = require('../clinic/doctors.service');
const scheduling = require('../clinic/scheduling');
const { landingFor } = require('../auth/session');
const options = require('../settings/options');
const { form } = require('../settings/form');
const { takeStash, stash, baseUrl } = require('../settings/common');
const team = require('../settings/team.web');

const router = express.Router();
router.use(can('settings.manage'));

const STEPS = ['clinic', 'region', 'doctors', 'services', 'team', 'page'];
const next = (step) => STEPS[STEPS.indexOf(step) + 1] || null;
const go = (res, step) => res.redirect(step ? `/app/onboarding/${step}` : '/app/onboarding/finish');

async function advance(req, step) {
  const n = next(step);
  const cur = STEPS.indexOf(req.business.onboarding_step);
  // Never move the saved position backwards when someone revisits an earlier step.
  if (n && STEPS.indexOf(n) > cur) await businesses.setOnboarding(req.ctx.businessId, n);
  return n;
}

async function stepData(req, step) {
  const b = req.ctx.businessId;
  switch (step) {
    case 'clinic': return { specialtyOptions: options.specialtyOptions(req.t) };
    case 'region': return { currencyOptions: options.currencyOptions(req.t), zoneOptions: options.zoneOptions(req.locale), countryOptions: options.countryOptions(req.locale) };
    case 'doctors': {
      const doctors = await knex('doctors').where({ business_id: b }).orderBy('id').select('id', 'full_name', 'specialization', 'consultation_fee', 'slot_duration_minutes');
      const mine = await knex('memberships').where({ business_id: b, user_id: req.ctx.userId }).first('doctor_id');
      return { doctors, ownerLinked: Boolean(mine && mine.doctor_id), days: scheduling.DAY_KEYS };
    }
    case 'services': {
      const services = await knex('services as s').leftJoin('doctors as d', 'd.id', 's.doctor_id').where('s.business_id', b).orderBy('s.id').select('s.id', 's.name', 's.price', 's.duration_minutes', 'd.full_name as doctor_name');
      const doctors = await knex('doctors').where({ business_id: b, is_active: true }).orderBy('full_name').select('id', 'full_name');
      return { services, doctors };
    }
    case 'team': {
      const data = await team.teamData(req);
      return { ...data, emailEnabled: mailer.configured(), prefill: null, result: takeStash(req, 'teamResult') };
    }
    case 'page': return { base: baseUrl(req), suggestion: req.business.slug || await businesses.suggestSlug(req.business.name_en || req.business.name) };
    default: return {};
  }
}

async function renderStep(req, res, step, extra = {}) {
  res.page(`pages/onboarding/${step}`, {
    layout: 'onboarding', title: req.t('onboarding.title'), steps: STEPS, step, stepNo: STEPS.indexOf(step) + 1, prev: STEPS[STEPS.indexOf(step) - 1] || null,
    b: req.business, pageStyles: ['/css/admin.css'], pageScripts: ['/js/admin.js'], ...(await stepData(req, step)), ...extra,
  });
}

router.get('/', (req, res) => go(res, STEPS.includes(req.business.onboarding_step) ? req.business.onboarding_step : 'clinic'));
router.get('/finish', (req, res) => res.redirect('/app/onboarding/page'));

// ---------------------------------------------------------------- finish (also "skip setup" in the header)
router.post('/finish', wrap(async (req, res) => {
  await businesses.setOnboarding(req.ctx.businessId, 'done', true);
  await audit.record(req.ctx, 'clinic.setup_completed', { entityType: 'clinic', entityId: req.ctx.businessId });
  flash(req, 'success', req.t('onboarding.done', { name: req.business.name }));
  res.redirect(await landingFor(req.ctx.userId, req.ctx.businessId));
}));

// ---------------------------------------------------------------- 1. clinic details
const phone = () => z.preprocess(emptyToUndefined, z.string().trim().max(40).regex(/^[+0-9\s()-]{6,40}$/, 'Enter a valid phone number.').optional());
const saveClinic = async (req) => {
  const d = validate(z.object({
    name: z.string().trim().min(2, 'Enter the clinic name.').max(160), name_en: optionalString(160),
    specialty: z.preprocess(emptyToUndefined, z.enum(options.SPECIALTIES).optional()), phone: phone(), whatsapp: phone(), city: optionalString(100),
  }), req.body);
  await businesses.updateProfile(req.ctx, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v])));
};
// ---------------------------------------------------------------- 2. region
const saveRegion = async (req) => {
  const d = validate(z.object({
    timezone: z.enum(options.ZONE_IDS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
    currency: z.enum(options.CURRENCIES, { errorMap: () => ({ message: 'Choose a currency.' }) }),
    country: z.preprocess(emptyToUndefined, z.enum(options.COUNTRIES).optional()),
  }), req.body);
  await businesses.updateProfile(req.ctx, { ...d, country: d.country || options.countryForZone(d.timezone) });
};
// ---------------------------------------------------------------- 6. clinic page
const savePage = async (req) => {
  if (req.body.slug !== req.business.slug) await businesses.setSlug(req.ctx, req.body.slug);
  await businesses.updateProfile(req.ctx, { booking_enabled: req.body.booking_enabled === '1' });
};
const SAVERS = { clinic: saveClinic, region: saveRegion, page: savePage };

// ---------------------------------------------------------------- 3. doctors (quick add)
router.post('/doctors/add', form(async (req, res) => {
  const d = validate(z.object({
    full_name: z.string().trim().min(2, 'Required.').max(190), specialization: optionalString(190),
    consultation_fee: z.string().optional(), slot_duration_minutes: z.string().optional(),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a valid time.'), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a valid time.'),
  }), req.body);
  if (scheduling.timeToMinutes(d.end) <= scheduling.timeToMinutes(d.start)) throw E.validation({ end: 'Enter a valid time.' });
  const days = [].concat(req.body.days || []).filter((x) => scheduling.DAY_KEYS.includes(x));
  const wh = Object.fromEntries(scheduling.DAY_KEYS.map((k) => [k, days.includes(k) ? { enabled: '1', s1: d.start, e1: d.end } : {}]));
  const id = await doctorsSvc.saveDoctor(req.ctx, null, {
    full_name: d.full_name, specialization: d.specialization, consultation_fee: req.body.consultation_fee, slot_duration_minutes: req.body.slot_duration_minutes || '30',
    base_salary: '0', is_active: '1', show_consultation_fee: '1', sort_order: '', wh,
  });
  if (req.body.is_me === '1') {
    const m = await knex('memberships').where({ business_id: req.ctx.businessId, user_id: req.ctx.userId }).first('id', 'doctor_id');
    if (m && !m.doctor_id) {
      await knex('memberships').where({ id: m.id }).update({ doctor_id: id, updated_at: new Date() });
      await audit.record(req.ctx, 'staff.updated', { entityType: 'staff', entityId: req.ctx.userId, newValues: { doctor_id: id } });
      rbac.invalidate(req.ctx.businessId);
    }
  }
  flash(req, 'success', req.t('onboarding.doctor_added', { name: d.full_name }));
  res.redirect('/app/onboarding/doctors');
}, (req, res, extra) => renderStep(req, res, 'doctors', extra)));

// ---------------------------------------------------------------- 4. services (quick add)
router.post('/services/add', form(async (req, res) => {
  await doctorsSvc.saveService(req.ctx, null, { name: req.body.name, price: req.body.price, duration_minutes: req.body.duration_minutes || '30', doctor_id: req.body.doctor_id, is_active: '1', show_price: '1', sort_order: '' });
  flash(req, 'success', req.t('onboarding.service_added', { name: String(req.body.name || '').trim() }));
  res.redirect('/app/onboarding/services');
}, (req, res, extra) => renderStep(req, res, 'services', extra)));

// ---------------------------------------------------------------- 5. staff logins (same as Settings → Staff & logins)
router.post('/team/add', can('users.manage'), form(async (req, res) => {
  const result = await team.addLogin(req, req.body);
  stash(req, 'teamResult', result);
  res.redirect('/app/onboarding/team');
}, (req, res, extra) => renderStep(req, res, 'team', { ...extra, result: null })));

// ---------------------------------------------------------------- step pages
router.get('/:step', wrap(async (req, res) => {
  if (!STEPS.includes(req.params.step)) return go(res, 'clinic');
  return renderStep(req, res, req.params.step);
}));
router.post('/:step', form(async (req, res) => {
  const { step } = req.params;
  if (!STEPS.includes(step)) throw E.notFound('Step');
  if (req.body._action !== 'skip' && SAVERS[step]) await SAVERS[step](req);
  const n = await advance(req, step);
  if (!n) {
    await businesses.setOnboarding(req.ctx.businessId, 'done', true);
    await audit.record(req.ctx, 'clinic.setup_completed', { entityType: 'clinic', entityId: req.ctx.businessId });
    flash(req, 'success', req.t('onboarding.done', { name: (await businesses.get(req.ctx.businessId)).name }));
    return res.redirect(await landingFor(req.ctx.userId, req.ctx.businessId));
  }
  return go(res, n);
}, (req, res, extra) => renderStep(req, res, req.params.step, extra)));

module.exports = router;
