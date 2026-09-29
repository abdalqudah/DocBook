const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const scheduling = require('./scheduling');
const svc = require('./doctors.service');
const payroll = require('./payroll.service');
const tele = require('../telehealth/telehealth.service');

const router = express.Router();
router.use(canAny('doctors.manage', 'appointments.view_all'));

router.get('/', wrap(async (req, res) => {
  const rows = await knex('doctors').where({ business_id: req.ctx.businessId }).orderBy([{ column: 'is_active', order: 'desc' }, { column: 'sort_order' }, { column: 'full_name' }]);
  const today = req.ctx.today;
  const counts = await knex('appointments').where({ business_id: req.ctx.businessId, appointment_date: today }).whereNot('status', 'cancelled').whereNot('appointment_type', 'blocked').groupBy('doctor_id').select('doctor_id').count({ n: '*' });
  const accounts = await knex('memberships').where({ business_id: req.ctx.businessId }).whereNotNull('doctor_id').select('doctor_id', 'status');
  res.page('pages/clinic/doctors/index', { title: req.t('nav.doctors'), rows, todayCounts: Object.fromEntries(counts.map((c) => [c.doctor_id, Number(c.n)])), accounts: Object.fromEntries(accounts.map((a) => [a.doctor_id, a.status])), dayKey: scheduling.dayKeyOf(today), parseWh: svc.parseWh });
}));

const renderForm = async (req, res, extra = {}) => {
  const doctor = req.params.id ? await svc.doctors.get(req.ctx, Number(req.params.id)) : null;
  const onlineWindows = tele.windowsByDay(doctor ? await tele.windowsOf(req.ctx.businessId, doctor.id) : []);
  res.page('pages/clinic/doctors/form', {
    title: doctor ? req.t('doctors.edit') : req.t('doctors.add'), doctor, wh: doctor ? svc.parseWh(doctor.working_hours) : scheduling.defaultWorkingHours(), days: scheduling.DAY_KEYS,
    onlineWindows, jitsiReady: Boolean(tele.jitsiBase()), clinicOnline: Boolean(req.business.online_enabled), ...extra,
  });
};
router.get('/new', can('doctors.manage'), wrap((req, res) => renderForm(req, res)));
router.post('/new', can('doctors.manage'), form(async (req, res) => {
  const id = await svc.saveDoctor(req.ctx, null, req.body);
  flash(req, 'success', req.t('doctors.saved'));
  res.redirect(`/app/doctors/${id}`);
}, renderForm));
router.get('/:id(\\d+)/edit', can('doctors.manage'), wrap((req, res) => renderForm(req, res)));
router.post('/:id(\\d+)/edit', can('doctors.manage'), form(async (req, res) => {
  await svc.saveDoctor(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(`/app/doctors/${req.params.id}`);
}, renderForm));

const renderShow = async (req, res, extra = {}) => {
  const doctor = await svc.doctors.get(req.ctx, Number(req.params.id));
  const [daysOff, services, account, rule, upcoming] = await Promise.all([
    svc.daysOff(req.ctx, doctor.id),
    knex('services').where({ business_id: req.ctx.businessId, doctor_id: doctor.id }).orderBy('sort_order'),
    knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.business_id': req.ctx.businessId, 'm.doctor_id': doctor.id }).first('u.name', 'u.email', 'm.status', 'u.last_login_at'),
    payroll.rule(req.ctx, doctor.id),
    knex('appointments').where({ business_id: req.ctx.businessId, doctor_id: doctor.id }).where('appointment_date', '>=', req.ctx.today).whereNot('status', 'cancelled').whereNot('appointment_type', 'blocked').orderBy([{ column: 'appointment_date' }, { column: 'appointment_time' }]).limit(8),
  ]);
  const online = { ...tele.doctorOnline(doctor), method: tele.effectiveMethod(doctor), windows: tele.windowsByDay(await tele.windowsOf(req.ctx.businessId, doctor.id)), clinicOn: Boolean(req.business.online_enabled) };
  res.page('pages/clinic/doctors/show', { title: doctor.full_name, doctor, wh: svc.parseWh(doctor.working_hours), days: scheduling.DAY_KEYS, daysOff, services, account, rule, upcoming, online, ...extra });
};
router.get('/:id(\\d+)', wrap((req, res) => renderShow(req, res)));
router.post('/:id(\\d+)/days-off', can('doctors.manage'), form(async (req, res) => {
  await svc.addDayOff(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('doctors.day_off_added'));
  res.redirect(`/app/doctors/${req.params.id}`);
}, renderShow));
router.post('/:id(\\d+)/days-off/:off(\\d+)/delete', can('doctors.manage'), wrap(async (req, res) => {
  await svc.removeDayOff(req.ctx, Number(req.params.id), Number(req.params.off));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(`/app/doctors/${req.params.id}`);
}));
router.post('/:id(\\d+)/delete', can('doctors.manage'), wrap(async (req, res) => {
  await svc.doctors.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('doctors.deleted'));
  res.redirect('/app/doctors');
}));

module.exports = router;
