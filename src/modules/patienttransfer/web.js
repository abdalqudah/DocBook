// Patients → move / share to another clinic of the owner (patienttransfer/transfer.service.js):
//   GET  /app/patients/transfer?ids=…  (or ?all=1 + the list's filters)  → choose the clinic, the mode, a doctor there
//   POST /app/patients/transfer                                           → queued; runs in the background
//   GET  /app/patients/transfer/:id                                       → progress and the result per patient
//   GET  /app/patients/transfer                                           → past transfers + "update shared patients"
//   POST /app/patients/transfer/sync          (other, patient_id?)        → pull what is new in the other clinic
//   POST /app/patients/transfer/restore/:pid                              → a moved patient back in this clinic's list
// Only members who manage the data (data.manage) of both clinics — checked again in the service.
const express = require('express');
const knex = require('../../db/knex');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const svc = require('./transfer.service');

const router = express.Router();
router.use(can('data.manage'));
const BASE = '/app/patients/transfer';
const PAGE = { pageScripts: ['/js/patient-transfer.js'], pageStyles: ['/css/records.css'] };
const errText = (req, e) => { const k = `ptransfer.err.${e.code}`; return req.t(k) !== k ? req.t(k) : e.message; };
const idsOf = (v) => [].concat(v || []).flatMap((x) => String(x).split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0);

/** The chosen patients: the ticked ones, or every patient matching the list's search and filters. */
async function chosen(req, src) {
  if (src.all === '1') {
    const listQuery = require('../clinic/patients.web').listQuery; // eslint-disable-line global-require
    return listQuery(req.ctx, src).clearSelect().clearOrder().orderBy('patients.full_name').limit(svc.MAX).select('patients.id', 'patients.full_name', 'patients.phone', 'patients.file_number');
  }
  const ids = idsOf(src.ids).slice(0, svc.MAX);
  if (!ids.length) return [];
  return knex('patients').where({ business_id: req.ctx.businessId }).whereIn('id', ids).whereNull('transferred_at').orderBy('full_name').select('id', 'full_name', 'phone', 'file_number');
}

router.get('/', wrap(async (req, res) => {
  const targets = await svc.targets(req.ctx);
  if (req.query.ids || req.query.all === '1') {
    const patients = await chosen(req, req.query);
    const to = targets.find((b) => b.id === Number(req.query.to)) || (targets.length === 1 ? targets[0] : null);
    const doctors = to ? await svc.doctorsOf(to.id) : [];
    return res.page('pages/patienttransfer/new', { title: req.t('ptransfer.title'), targets, patients, to, doctors, mode: req.query.mode === 'move' ? 'move' : 'share', query: req.query, ...PAGE });
  }
  const [list, shared] = await Promise.all([svc.list(req.ctx), svc.sharedCounts(req.ctx)]);
  return res.page('pages/patienttransfer/index', { title: req.t('ptransfer.history'), targets, list, shared, ...PAGE });
}));

router.post('/', wrap(async (req, res) => {
  try {
    const patients = await chosen(req, req.body);
    const id = await svc.start(req.ctx, { to: req.body.to, patientIds: patients.map((p) => p.id), mode: req.body.mode, defaultDoctorId: req.body.doctor_id || null });
    flash(req, 'success', req.t('ptransfer.started'));
    return res.redirect(`${BASE}/${id}`);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', errText(req, e));
    return res.redirect(req.body.ids ? `${BASE}?ids=${idsOf(req.body.ids).join(',')}` : '/app/patients');
  }
}));

router.post('/sync', wrap(async (req, res) => {
  try {
    const id = await svc.sync(req.ctx, { other: req.body.other, patientIds: req.body.patient_id ? idsOf(req.body.patient_id) : null });
    flash(req, 'success', req.t('ptransfer.sync_started'));
    return res.redirect(`${BASE}/${id}`);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', errText(req, e));
    return res.redirect(req.body.patient_id ? `/app/patients/${idsOf(req.body.patient_id)[0]}` : BASE);
  }
}));

router.post('/restore/:pid(\\d+)', wrap(async (req, res) => {
  await svc.restore(req.ctx, req.params.pid);
  flash(req, 'success', req.t('ptransfer.restored'));
  res.redirect(`/app/patients/${Number(req.params.pid)}`);
}));

router.get('/:id(\\d+)', wrap(async (req, res) => {
  const t = await svc.getTransfer(req.ctx, req.params.id);
  const [items, names] = await Promise.all([svc.items(t.id), knex('businesses').whereIn('id', [t.from_business_id, t.to_business_id]).select('id', 'name')]);
  const nameOf = (id) => (names.find((b) => b.id === id) || {}).name || `#${id}`;
  res.page('pages/patienttransfer/show', { title: req.t('ptransfer.title'), tr: t, items, fromName: nameOf(t.from_business_id), toName: nameOf(t.to_business_id), here: req.ctx.businessId, report: JSON.parse(t.report || '{}'), ...PAGE });
}));
router.get('/:id(\\d+)/status', wrap(async (req, res) => {
  const t = await svc.getTransfer(req.ctx, req.params.id);
  res.set('Cache-Control', 'no-store');
  res.json({ status: t.status, done: t.done, failed: t.failed, total: t.total });
}));
router.post('/:id(\\d+)/retry', wrap(async (req, res) => {
  await svc.retry(req.ctx, req.params.id);
  res.redirect(`${BASE}/${Number(req.params.id)}`);
}));

module.exports = router;
