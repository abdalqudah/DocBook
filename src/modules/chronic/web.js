// Chronic disease tracking (متابعة الأمراض المزمنة). Mounted at '/' in /app after '/patients' (whose router has
// already required patients.view for the patient addresses). The Tracking tab itself is drawn by patients.web.
//   POST /app/patients/:id/chronic/conditions[/:cid/delete]   mark / remove a chronic condition (clinical.edit)
//   POST /app/patients/:id/chronic/readings[/:rid/delete]     add / remove a reading (clinical.edit or vitals.edit)
//   GET  /app/chronic                                         patients with chronic conditions (clinical.view)
//   POST /app/chronic/settings                                days without a visit or reading before follow-up is overdue (settings.manage)
// The clinic's record-privacy rule (clinicalplus/privacy.service) applies: a restricted record cannot be changed here.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { AppError, E } = require('../../core/errors');
const lib = require('../clinic/records.lib');
const branchesSvc = require('../clinic/branches.service');
const privacy = require('../clinicalplus/privacy.service');
const svc = require('./service');
const view = require('./view');
const vmsg = { ar: require('../../locales/ar/chronic.json').chronic.vmsg, en: require('../../locales/en/chronic.json').chronic.vmsg };

const router = express.Router();

async function patientFor(req) {
  const q = knex('patients').where({ 'patients.business_id': req.ctx.businessId, 'patients.id': Number(req.params.id) }).first('patients.id', 'patients.full_name');
  lib.scopePatientsToDoctor(q, req.ctx.ownDoctorId);
  branchesSvc.scopePatients(q, req.ctx);
  const p = await q;
  if (!p) throw E.notFound('Patient');
  return p;
}
/** The patient, when this member may change its record (`what`: 'clinical', or 'vitals' for readings). */
async function writable(req, what) {
  const p = await patientFor(req);
  const acc = await privacy.access(req.ctx, { patientId: p.id });
  if (!(acc.clinical || (what === 'vitals' && acc.vitals))) throw E.forbidden('clinical.edit');
  return p;
}
const tabUrl = (id) => `/app/patients/${id}?tab=tracking`;

/** Runs a change and comes back to the tab; a refused value is flashed with the field's name. */
const change = (fn) => wrap(async (req, res) => {
  const id = Number(req.params.id);
  try {
    await fn(req, res);
  } catch (e) {
    if (!(e instanceof AppError) || e.status !== 422) throw e;
    const tr = (m) => (vmsg[req.locale] || vmsg.en)[m] || m;
    const parts = Object.entries(e.details || {}).map(([k, m]) => `${req.t(`chronic.fields.${k}`)}: ${tr(m)}`);
    flash(req, 'error', `${req.t('chronic.invalid')} ${parts.join(' · ')}`.trim());
  }
  if (!res.headersSent) res.redirect(tabUrl(id));
});

router.post('/patients/:id(\\d+)/chronic/conditions', can('clinical.edit'), change(async (req) => {
  const p = await writable(req, 'clinical');
  await svc.addCondition(req.ctx, p, req.body);
  flash(req, 'success', req.t('chronic.condition_saved'));
}));
router.post('/patients/:id(\\d+)/chronic/conditions/:cid(\\d+)/delete', can('clinical.edit'), change(async (req) => {
  const p = await writable(req, 'clinical');
  await svc.removeCondition(req.ctx, p, req.params.cid);
  flash(req, 'success', req.t('chronic.condition_removed'));
}));
router.post('/patients/:id(\\d+)/chronic/readings', canAny('clinical.edit', 'vitals.edit'), change(async (req) => {
  const p = await writable(req, 'vitals');
  await svc.addReading(req.ctx, p, req.body);
  flash(req, 'success', req.t('chronic.reading_saved'));
}));
router.post('/patients/:id(\\d+)/chronic/readings/:rid(\\d+)/delete', canAny('clinical.edit', 'vitals.edit'), change(async (req) => {
  const p = await writable(req, 'vitals');
  await svc.removeReading(req.ctx, p, req.params.rid);
  flash(req, 'success', req.t('chronic.reading_removed'));
}));

// ---------------------------------------------------------------- the clinic-wide list
router.get('/chronic', can('clinical.view'), wrap(async (req, res) => {
  const condition = svc.CONDITIONS.includes(req.query.condition) ? req.query.condition : '';
  const overdueOnly = req.query.overdue === '1';
  const { rows, overdueDays } = await svc.chronicList(req.ctx, { condition, overdueOnly });
  res.page('pages/chronic/index', {
    title: req.t('chronic.list_title'), rows, overdueDays, condition, overdueOnly, conditions: svc.CONDITIONS,
    valueText: (r) => view.valueText(r, req.locale), pageStyles: ['/css/records.css'],
  });
}));
router.post('/chronic/settings', can('settings.manage'), wrap(async (req, res) => {
  try {
    await svc.saveSettings(req.ctx, req.body);
    flash(req, 'success', req.t('common.updated'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status !== 422) throw e;
    flash(req, 'error', req.t('chronic.overdue_invalid'));
  }
  res.redirect('/app/chronic');
}));

/** What the patient page needs: the condition badges (any tab) and, on the Tracking tab, the charts and readings. */
async function forPatientPage(req, patient, { full }) {
  const conditions = await svc.conditionsOf(req.ctx, patient.id);
  if (!full) return { conditions };
  const tr = await svc.trackingOf(req.ctx, patient);
  return {
    conditions, readings: tr.readings.slice().reverse(), charts: view.charts(tr, req.t, req.locale), heightCm: tr.heightCm,
    kinds: svc.KIND_KEYS, units: Object.fromEntries(svc.KIND_KEYS.map((k) => [k, svc.KINDS[k].unit])), contexts: svc.GLUCOSE_CONTEXTS, conditionKeys: svc.CONDITIONS,
    valueText: (r) => view.valueText(r, req.locale),
    canCondition: req.ctx.permissions.has('clinical.edit'),
    canReading: req.ctx.permissions.has('clinical.edit') || req.ctx.permissions.has('vitals.edit'),
  };
}

router.forPatientPage = forPatientPage;
module.exports = router;
