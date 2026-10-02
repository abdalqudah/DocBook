// Specialty records: dental chart, child growth, pregnancy follow-up (worker: specialty).
// Mounted at '/' in /app before '/visits' (but after '/patients', whose router has already required patients.view).
//   /app/patients/:id/dental | /growth | /pregnancy   (clinical.view to see, clinical.edit to record; growth also vitals.edit)
//   /app/specialty/settings                           (settings.manage: modules on/off + the antenatal schedule template)
//   /app/specialty/panel/:patientId                   (HTML fragment for the patient page's side panel)
//   GET /app/visits/:id                                → loader: res.locals.specialtyPanel for the visit page's side panel
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const appts = require('../clinic/appointments.service');
const lib = require('../clinic/records.lib');
const svc = require('./service');
const dental = require('./dental');
const growth = require('./growth');
const growthChart = require('./growth-chart');
const preg = require('./pregnancy');
const vmsgAr = require('../../locales/ar/specialty.json').errors_specialty.vmsg;

const router = express.Router();

const ASSETS = { pageScripts: ['/js/specialty.js'], pageStyles: ['/css/specialty.css'] };
const MODULE_ICON = { dental: 'smile', growth: 'ruler', pregnancy: 'baby' };

/** Like helpers.form, but translates this module's own validation messages / error codes first. */
const sform = (action, rerender) => wrap(async (req, res, next) => {
  try {
    await action(req, res, next);
  } catch (err) {
    if (err instanceof AppError && [404, 409, 422].includes(err.status) && rerender && !(err.status === 404 && err.code === 'NOT_FOUND' && !err.details)) {
      const tr = (m) => (req.locale === 'ar' && vmsgAr[m] ? vmsgAr[m] : translateMessage(req.locale, m));
      const own = req.t(`errors_specialty.${err.code}`);
      const shared = req.t(`errors.${err.code}`);
      res.status(err.status);
      return rerender(req, res, {
        errors: err.details && err.code === 'VALIDATION_FAILED' ? Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k, tr(v)])) : {},
        formError: { code: err.code, message: own !== `errors_specialty.${err.code}` ? own : shared !== `errors.${err.code}` ? shared : err.message },
        old: req.body,
      });
    }
    throw err;
  }
});

// ---------------------------------------------------------------- shared loading
async function context(req, moduleKey) {
  const settings = await svc.settings(req.business);
  if (moduleKey && !settings[moduleKey]) throw new AppError('NOT_FOUND', 'Module is off.', 404);
  const patient = await svc.patientFor(req.ctx, req.params.id);
  const visitId = req.query.visit || (req.body && req.body.visit_id);
  const visit = await svc.visitFor(req.ctx, patient, visitId);
  const today = req.ctx.today;
  return { settings, patient, visit, today, age: lib.ageOf(patient.date_of_birth, today), ageDays: svc.ageDays(patient, today) };
}
const selfUrl = (c, key, extra = '') => {
  const q = [c.visit ? `visit=${c.visit.id}` : '', extra].filter(Boolean).join('&');
  return `/app/patients/${c.patient.id}/${key}${q ? `?${q}` : ''}`;
};
const L = (req) => (ar, en) => (req.locale === 'en' && en ? en : ar);

/** Age as "1 y 3 m" / "5 m" / "12 d" for children. */
function childAge(req, days) {
  if (days === null || days === undefined || days < 0) return null;
  if (days < 61) return req.t('child_growth.age_days', { n: days });
  const months = Math.floor(days / growthChart.DAYS_PER_MONTH);
  const y = Math.floor(months / 12); const m = months % 12;
  if (!y) return req.t('child_growth.age_months', { n: m });
  return m ? req.t('child_growth.age_years_months', { y, m }) : req.t('child_growth.age_years', { y });
}

// ---------------------------------------------------------------- visit page loader (runs before visits.web)
router.get('/visits/:id(\\d+)', async (req, res, next) => {
  try {
    if (req.ctx.permissions.has('clinical.view')) {
      const a = await appts.get(req.ctx, Number(req.params.id)).catch(() => null);
      if (a && a.patient_id) {
        const patient = await svc.patientFor(req.ctx, a.patient_id).catch(() => null);
        const sp = patient ? await svc.summary(req.ctx, req.business, patient) : null;
        if (sp) res.locals.specialtyPanel = { ...sp, visitId: a.id, settingsLink: req.ctx.permissions.has('settings.manage') };
      }
    }
  } catch (e) { /* the panel is optional: never break the visit page */ }
  next();
});

// Patient page panel: fetched by public/js/specialty.js (the patients router renders that page before this router runs).
router.get('/specialty/panel/:pid(\\d+)', can('clinical.view'), wrap(async (req, res) => {
  const patient = await svc.patientFor(req.ctx, req.params.pid);
  const sp = await svc.summary(req.ctx, req.business, patient);
  if (!sp) return res.status(204).end();
  return res.render('pages/specialty/_summary', { sp: { ...sp, visitId: null, settingsLink: req.ctx.permissions.has('settings.manage') }, ageText: null });
}));

// ================================================================= DENTAL
async function renderDental(req, res, extra = {}) {
  const c = await context(req, 'dental');
  const data = await svc.dentalData(req.ctx, c.patient);
  const setParam = req.query.set;
  const hasPrimary = data.entries.some((e) => !e.voided_at && dental.isPrimaryTooth(e.tooth));
  const primary = setParam === 'primary' || (setParam !== 'permanent' && ((c.ageDays !== null && c.ageDays < 6 * 365) || (hasPrimary && c.ageDays === null)));
  const selected = dental.isTooth(req.query.tooth) ? Number(req.query.tooth) : null;
  const t = req.t;
  const labels = {
    tooth: t('dental.tooth'), sound: t('dental.sound'),
    condition: (k) => t(`dental.conditions.${k}`), surface: (s) => t(`dental.surfaces.${s}`), quadrant: (q) => t(`dental.quadrants.${q}`),
  };
  const quadrants = dental.chartQuadrants(data.state, { primary, labels, selected });
  const charted = Object.entries(data.state).map(([n, st]) => ({ tooth: Number(n), conds: dental.toothConditions(st), st }))
    .filter((r) => r.conds.length).sort((a, b) => a.tooth - b.tooth);
  const planned = data.plan.filter((i) => i.status === 'planned');
  const plannedTotal = planned.reduce((s, i) => s + (i.price !== null ? Number(i.price) : 0), 0);
  const entries = selected ? data.entries.filter((e) => e.tooth === selected) : data.entries;
  const openDialog = extra.openDialog || (req.query.record === '1' && req.ctx.permissions.has('clinical.edit') ? 'dental-entry-dialog' : undefined);
  res.page('pages/specialty/dental', {
    title: `${t('dental.title')} · ${c.patient.full_name}`, printable: true, ...c, ...data, entries, allEntries: data.entries, primary, selected, quadrants, charted, planned, plannedTotal,
    legend: dental.CONDITION_KEYS.filter((k) => k !== 'healthy').map((k) => ({ key: k, code: dental.CONDITIONS[k].code, svg: dental.legendSvg(k) })),
    patternDefs: dental.PATTERN_DEFS, conditions: dental.CONDITIONS, materials: dental.MATERIALS, surfaces: dental.SURFACES, L: L(req),
    selfUrl: (extraQ) => selfUrl(c, 'dental', extraQ), ...ASSETS, ...extra, openDialog,
  });
}
router.get('/patients/:id(\\d+)/dental', can('clinical.view'), wrap((req, res) => renderDental(req, res)));

router.post('/patients/:id(\\d+)/dental/entries', can('clinical.edit'), sform(async (req, res) => {
  const c = await context(req, 'dental');
  await svc.addDentalEntry(req.ctx, c.patient, req.body, c.visit);
  flash(req, 'success', req.t('dental.entry_saved'));
  res.redirect(selfUrl(c, 'dental', req.body.set ? `set=${req.body.set === 'primary' ? 'primary' : 'permanent'}` : ''));
}, (req, res, extra) => renderDental(req, res, { ...extra, openDialog: 'dental-entry-dialog' })));

router.post('/patients/:id(\\d+)/dental/entries/:eid(\\d+)/delete', can('clinical.edit'), wrap(async (req, res) => {
  const c = await context(req, 'dental');
  await svc.voidDentalEntry(req.ctx, c.patient, req.params.eid);
  flash(req, 'success', req.t('dental.entry_removed'));
  res.redirect(selfUrl(c, 'dental'));
}));

router.post('/patients/:id(\\d+)/dental/plan', can('clinical.edit'), sform(async (req, res) => {
  const c = await context(req, 'dental');
  await svc.addPlanItem(req.ctx, c.patient, req.body, c.visit);
  flash(req, 'success', req.t('dental.plan_saved'));
  res.redirect(`${selfUrl(c, 'dental')}#plan`);
}, (req, res, extra) => renderDental(req, res, { ...extra, openDialog: 'plan-dialog' })));

router.post('/patients/:id(\\d+)/dental/plan/:pid(\\d+)/status', can('clinical.edit'), wrap(async (req, res) => {
  const c = await context(req, 'dental');
  await svc.setPlanStatus(req.ctx, c.patient, req.params.pid, req.body.status, c.visit);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(`${selfUrl(c, 'dental')}#plan`);
}));

router.post('/patients/:id(\\d+)/dental/plan/:pid(\\d+)/delete', can('clinical.edit'), wrap(async (req, res) => {
  const c = await context(req, 'dental');
  await svc.deletePlanItem(req.ctx, c.patient, req.params.pid);
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(`${selfUrl(c, 'dental')}#plan`);
}));

// ================================================================= GROWTH
const IND = [
  { key: 'wfa', unit: 'kg', digits: 1 }, { key: 'lhfa', unit: 'cm', digits: 1 }, { key: 'hcfa', unit: 'cm', digits: 1 }, { key: 'bfa', unit: 'kg/m²', digits: 1 },
];

async function renderGrowth(req, res, extra = {}) {
  const c = await context(req, 'growth');
  const { measurements, fromVisits } = await svc.growthData(req.ctx, c.patient);
  const sex = growth.sexKey(c.patient.gender);
  const hasDob = Boolean(c.patient.date_of_birth);
  const t = req.t;
  const num = (v, d = 1) => (v === null || v === undefined ? '—' : new Intl.NumberFormat(req.locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { maximumFractionDigits: d }).format(v));
  const dateLabel = (d) => res.locals.fmt.date(d);
  const charts = hasDob ? IND.map((ind) => {
    const points = measurements.filter((m) => m.a[ind.key].value).map((m) => ({
      ageDays: m.a.ageDays, value: m.a[ind.key].value, label: `${dateLabel(m.measured_on)} · ${childAge(req, m.a.ageDays) || ''}`,
      tip: `${num(m.a[ind.key].value, ind.digits)} ${t(`child_growth.units.${ind.key}`)}${m.a[ind.key].p !== null ? ` · P${num(m.a[ind.key].p, 0)}` : ''}`,
    }));
    return {
      key: ind.key, count: points.length,
      svg: points.length || sex ? growthChart.render({
        indicator: ind.key, sex, points, withCurves: Boolean(sex), title: t(`child_growth.indicators.${ind.key}`), xLabel: t('child_growth.age_axis'), fmt: (v) => num(v, 1),
      }) : '',
    };
  }) : [];
  const beyond = measurements.some((m) => m.a.ageDays !== null && m.a.ageDays > growth.MAX_DAY) || (c.ageDays !== null && c.ageDays > growth.MAX_DAY);
  const prefill = c.visit ? { weight_kg: c.visit.vitals.weightKg || '', length_cm: c.visit.vitals.heightCm || '', measured_on: c.visit.appointment_date } : {};
  res.page('pages/specialty/growth', {
    title: `${t('child_growth.title')} · ${c.patient.full_name}`, printable: true, ...c, measurements: [...measurements].reverse(), fromVisits, charts, sex, hasDob, beyond,
    ageText: childAge(req, c.ageDays), childAge: (d) => childAge(req, d), num, prefill, whoSource: growth.WHO_SOURCE,
    canRecord: req.ctx.permissions.has('clinical.edit') || req.ctx.permissions.has('vitals.edit'),
    selfUrl: (q) => selfUrl(c, 'growth', q), ...ASSETS, ...extra,
    openDialog: extra.openDialog || (c.visit && req.query.record === '1' ? 'growth-dialog' : undefined),
  });
}
router.get('/patients/:id(\\d+)/growth', can('clinical.view'), wrap((req, res) => renderGrowth(req, res)));

router.post('/patients/:id(\\d+)/growth', canAny('clinical.edit', 'vitals.edit'), sform(async (req, res) => {
  const c = await context(req, 'growth');
  await svc.addMeasurement(req.ctx, c.patient, req.body, c.visit);
  flash(req, 'success', req.t('child_growth.saved'));
  res.redirect(selfUrl(c, 'growth'));
}, (req, res, extra) => renderGrowth(req, res, { ...extra, openDialog: 'growth-dialog' })));

router.post('/patients/:id(\\d+)/growth/:mid(\\d+)/delete', canAny('clinical.edit', 'vitals.edit'), wrap(async (req, res) => {
  const c = await context(req, 'growth');
  await svc.deleteMeasurement(req.ctx, c.patient, req.params.mid);
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(selfUrl(c, 'growth'));
}));

// ================================================================= PREGNANCY
async function renderPregnancy(req, res, extra = {}) {
  const c = await context(req, 'pregnancy');
  const list = await svc.pregnancies(req.ctx, c.patient);
  const wanted = Number(req.query.p);
  const current = list.find((p) => p.id === wanted) || list.find((p) => p.status === 'active') || null;
  const visits = current ? await svc.antenatalVisits(req.ctx, [current.id]) : [];
  const done = current ? await svc.checksFor(req.ctx, current.id) : {};
  const refDate = current && current.status === 'closed' ? current.outcome_date : c.today;
  const schedule = current ? preg.scheduleStatus(c.settings.schedule, { edd: current.edd, rh: current.rh, today: refDate, done }) : [];
  const ga = current ? preg.gaDaysOn(current.edd, refDate) : null;
  const t = req.t;
  const scheduleLabel = (i) => i.label || t(`pregnancy.schedule_items.${i.key}`);
  const lastWeight = c.visit && c.visit.vitals ? c.visit.vitals : {};
  const prefillVisit = c.visit ? { visit_date: c.visit.appointment_date, weight_kg: lastWeight.weightKg || '', bp: lastWeight.bloodPressure || '' } : {};
  res.page('pages/specialty/pregnancy', {
    title: `${t('pregnancy.title')} · ${c.patient.full_name}`, printable: true, ...c, list, current, visits, schedule, ga, refDate, scheduleLabel, prefillVisit,
    gaLabel: preg.gaLabel, gaOn: (d) => (current ? preg.gaLabel(preg.gaDaysOn(current.edd, d)) : '—'), startDate: current ? preg.addDays(current.edd, -preg.TERM_DAYS) : null,
    trimester: ga === null ? null : ga < 14 * 7 ? 1 : ga < 28 * 7 ? 2 : 3, eligible: c.patient.gender === 'female',
    riskFlags: preg.RISK_FLAGS, outcomes: preg.OUTCOMES, deliveryModes: preg.DELIVERY_MODES, presentations: preg.PRESENTATIONS, oedemaLevels: preg.OEDEMA, urineLevels: preg.URINE, bloodGroups: preg.BLOOD_GROUPS,
    customSchedule: c.settings.customSchedule, selfUrl: (q) => selfUrl(c, 'pregnancy', q), ...ASSETS, ...extra,
    openDialog: extra.openDialog || (c.visit && req.query.record === '1' ? (current && current.status === 'active' ? 'anc-dialog' : 'preg-dialog') : undefined),
  });
}
router.get('/patients/:id(\\d+)/pregnancy', can('clinical.view'), wrap((req, res) => renderPregnancy(req, res)));

router.post('/patients/:id(\\d+)/pregnancy', can('clinical.edit'), sform(async (req, res) => {
  const c = await context(req, 'pregnancy');
  await svc.startPregnancy(req.ctx, c.patient, req.body, c.visit);
  flash(req, 'success', req.t('pregnancy.started'));
  res.redirect(selfUrl(c, 'pregnancy'));
}, (req, res, extra) => renderPregnancy(req, res, { ...extra, openDialog: 'preg-dialog' })));

router.post('/patients/:id(\\d+)/pregnancy/:pid(\\d+)', can('clinical.edit'), sform(async (req, res) => {
  const c = await context(req, 'pregnancy');
  await svc.updatePregnancy(req.ctx, c.patient, req.params.pid, req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(selfUrl(c, 'pregnancy', `p=${req.params.pid}`));
}, (req, res, extra) => renderPregnancy(req, res, { ...extra, openDialog: 'preg-edit-dialog' })));

router.post('/patients/:id(\\d+)/pregnancy/:pid(\\d+)/close', can('clinical.edit'), sform(async (req, res) => {
  const c = await context(req, 'pregnancy');
  await svc.closePregnancy(req.ctx, c.patient, req.params.pid, req.body);
  flash(req, 'success', req.t('pregnancy.closed_ok'));
  res.redirect(selfUrl(c, 'pregnancy', `p=${req.params.pid}`));
}, (req, res, extra) => renderPregnancy(req, res, { ...extra, openDialog: 'close-dialog' })));

router.post('/patients/:id(\\d+)/pregnancy/:pid(\\d+)/reopen', can('clinical.edit'), sform(async (req, res) => {
  const c = await context(req, 'pregnancy');
  await svc.reopenPregnancy(req.ctx, c.patient, req.params.pid);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(selfUrl(c, 'pregnancy', `p=${req.params.pid}`));
}, (req, res, extra) => { flash(req, 'error', extra.formError.message); res.redirect(`/app/patients/${req.params.id}/pregnancy?p=${req.params.pid}`); }));

router.post('/patients/:id(\\d+)/pregnancy/:pid(\\d+)/visits', can('clinical.edit'), sform(async (req, res) => {
  const c = await context(req, 'pregnancy');
  await svc.addAntenatalVisit(req.ctx, c.patient, req.params.pid, req.body, c.visit);
  flash(req, 'success', req.t('pregnancy.visit_saved'));
  res.redirect(`${selfUrl(c, 'pregnancy', `p=${req.params.pid}`)}#visits`);
}, (req, res, extra) => renderPregnancy(req, res, { ...extra, openDialog: 'anc-dialog' })));

router.post('/patients/:id(\\d+)/pregnancy/:pid(\\d+)/visits/:vid(\\d+)/delete', can('clinical.edit'), wrap(async (req, res) => {
  const c = await context(req, 'pregnancy');
  await svc.deleteAntenatalVisit(req.ctx, c.patient, req.params.pid, req.params.vid);
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(`${selfUrl(c, 'pregnancy', `p=${req.params.pid}`)}#visits`);
}));

router.post('/patients/:id(\\d+)/pregnancy/:pid(\\d+)/checks', can('clinical.edit'), wrap(async (req, res) => {
  const c = await context(req, 'pregnancy');
  await svc.setCheck(req.ctx, c.patient, req.params.pid, String(req.body.key || ''), req.body.done === '1', req.body.done_on, c.settings.schedule);
  res.redirect(`${selfUrl(c, 'pregnancy', `p=${req.params.pid}`)}#schedule`);
}));

// ================================================================= SETTINGS
async function renderSettings(req, res, extra = {}) {
  const s = await svc.settings(req.business);
  const old = extra.old || null;
  let items = s.schedule;
  if (old && old.items) items = (Array.isArray(old.items) ? old.items : Object.values(old.items)).map((i) => ({ key: '', label: '', from: '', to: '', ...i }));
  res.page('pages/specialty/settings', {
    title: req.t('specialty_mod.settings_title'), s, items, defaults: preg.DEFAULT_SCHEDULE, moduleIcon: MODULE_ICON, modules: svc.shownModules(req.business, s),
    dxTable: require('../clinicalplus/icd.service').specialtyTable(req.business.specialty || 'general'), // eslint-disable-line global-require
    ...ASSETS, ...extra,
  });
}
router.get('/specialty/settings', can('settings.manage'), wrap((req, res) => renderSettings(req, res)));
router.post('/specialty/settings', can('settings.manage'), sform(async (req, res) => {
  await svc.saveSettings(req.ctx, req.business, req.body);
  flash(req, 'success', req.t('specialty_mod.settings_saved'));
  res.redirect('/app/specialty/settings');
}, renderSettings));

module.exports = router;
