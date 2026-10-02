// ICD-10 diagnosis codes, consultation timer, medical-record privacy + access log (worker: clinical).
// Mounted at '/' inside /app, before '/visits' (and before the specialty, AI and patient-docs routers):
//   GET  /icd/search?q=                       JSON autocomplete (bundled WHO ICD-10 + clinic codes, most-used first)
//   POST /visits/:id/timer/:action            start | pause | resume | stop the consultation timer
//   POST /patients/:id/emergency-access       break-glass access to a restricted record (24 h, reason required)
//   GET  /settings/privacy  POST …            "Only the treating doctor can open clinical notes"
//   GET  /settings/privacy/log                record-access log (filters + export)
//   GET  /settings/diagnosis-codes …          the clinic's own diagnosis codes
//   GET  /reports/diagnoses                   top diagnoses by period and doctor
//   GET  /reports/consultation-time           actual vs booked consultation minutes
// It also guards the clinical pages of other modules (specialty records, patient documents, AI assistant) with
// the privacy rule, so turning it on protects the whole record, not just the visit page.
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const charts = require('../../core/charts');
const exporter = require('../../core/exporter');
const fmtCore = require('../../core/format');
const { AppError, E } = require('../../core/errors');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const businesses = require('../businesses/business.service');
const settingsCommon = require('../settings/common');
const lib = require('../clinic/records.lib');
const appts = require('../clinic/appointments.service');
const icd = require('./icd.service');
const timer = require('./timer.service');
const privacy = require('./privacy.service');

const router = express.Router();
const wantsJson = (req) => (req.get('accept') || '').includes('application/json') || req.xhr;
const errText = (req, err) => {
  for (const k of [`errors_clinicalplus.${err.code}`, `errors.${err.code}`]) { const s = req.t(k); if (s !== k) return s; }
  return err.message;
};
const safeReturn = (v, fallback) => (typeof v === 'string' && /^\/app\/[\w\-/?=&#%.]*$/.test(v) ? v : fallback);
const monthsBack = (today, n = 24) => { const out = []; for (let i = 0; i < n; i += 1) out.push(lib.addMonths(today.slice(0, 7), -i)); return out; };
const docName = (req, d) => (req.locale === 'en' && d.full_name_en ? d.full_name_en : d.full_name);

// ---------------------------------------------------------------- privacy guard for other modules' clinical pages
function deny(req, res, back) {
  const message = req.t('errors_clinicalplus.RECORD_RESTRICTED');
  if (wantsJson(req) || req.path.endsWith('.pdf')) {
    if (req.path.endsWith('.pdf') && !wantsJson(req)) { flash(req, 'error', message); return res.redirect(back); }
    return res.status(403).json({ error: { code: 'RECORD_RESTRICTED', message } });
  }
  flash(req, 'error', message);
  return res.redirect(back);
}
const guardPatient = (allowVitals) => wrap(async (req, res, next) => {
  const acc = await privacy.access(req.ctx, { patientId: Number(req.params.pid) });
  if (acc.reason === 'no_permission' || acc.clinical || (allowVitals && acc.vitals)) return next();
  return deny(req, res, `/app/patients/${req.params.pid}`);
});
const guardVisit = wrap(async (req, res, next) => {
  const a = await knex('appointments').where({ id: Number(req.params.aid), business_id: req.ctx.businessId }).first('id', 'patient_id', 'doctor_id');
  if (!a) return next();
  const acc = await privacy.access(req.ctx, { appointment: a });
  if (acc.reason === 'no_permission' || acc.clinical) return next();
  return deny(req, res, `/app/visits/${a.id}`);
});
router.use(['/patients/:pid(\\d+)/dental', '/patients/:pid(\\d+)/pregnancy', '/specialty/panel/:pid(\\d+)'], guardPatient(false));
router.use('/patients/:pid(\\d+)/growth', guardPatient(true));
router.use(['/patient-docs/:aid(\\d+)', '/visits/:aid(\\d+)/ai'], guardVisit);

// ---------------------------------------------------------------- ICD search (JSON)
router.get('/icd/search', canAny('clinical.view', 'clinical.edit', 'settings.manage'), wrap(async (req, res) => {
  const q = String(req.query.q || '').slice(0, 80);
  const rows = await icd.search(req.ctx.businessId, q, { limit: 20 });
  res.set('Cache-Control', 'private, no-store');
  res.json({ data: rows.map((r) => ({ code: r.code, title: icd.titleOf(r, req.locale), alt: icd.titleOf(r, req.locale === 'en' ? 'ar' : 'en'), custom: r.custom, uses: r.uses })) });
}));

// ---------------------------------------------------------------- consultation timer
router.post('/visits/:id(\\d+)/timer/:action(start|pause|resume|stop)', can('clinical.edit'), wrap(async (req, res) => {
  const back = `/app/visits/${req.params.id}#timer`;
  try {
    const a = await appts.get(req.ctx, Number(req.params.id)); // doctor logins: own schedule only
    if (a.appointment_type === 'blocked') throw E.notFound('Appointment');
    const acc = await privacy.access(req.ctx, { appointment: a });
    if (!acc.clinical) throw new AppError('RECORD_RESTRICTED', 'This clinical record is restricted.', 403);
    const { action } = req.params;
    if (action === 'start' && ['cancelled', 'no_show'].includes(a.status)) throw new AppError('VISIT_CLOSED', 'This visit is closed.', 409);
    const t = await timer[action](req.ctx, a);
    if (wantsJson(req)) return res.json({ data: timer.view(t) });
    return res.redirect(back);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (wantsJson(req)) return res.status(err.status || 400).json({ error: { code: err.code, message: errText(req, err) } });
    flash(req, 'error', errText(req, err));
    return res.redirect(back);
  }
}));

// ---------------------------------------------------------------- break-glass
router.post('/patients/:id(\\d+)/emergency-access', can('clinical.edit'), wrap(async (req, res) => {
  const back = safeReturn(req.body._return, `/app/patients/${req.params.id}`);
  const p = await knex('patients').where({ id: Number(req.params.id), business_id: req.ctx.businessId }).first('id', 'full_name');
  if (!p) throw E.notFound('Patient');
  try {
    await privacy.breakGlass(req.ctx, p, req.body);
    flash(req, 'success', req.t('privacy.bg_granted', { hours: privacy.GRANT_HOURS }));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    flash(req, 'error', err.code === 'VALIDATION_FAILED' ? req.t('privacy.bg_reason_short') : errText(req, err));
  }
  res.redirect(back);
}));

// ---------------------------------------------------------------- Settings → Record privacy
const SETTINGS_ASSETS = { pageStyles: ['/css/admin.css', '/css/clinicalplus.css'], pageScripts: ['/js/admin.js', '/js/clinicalplus.js'] };

router.get('/settings/privacy', canAny('settings.manage', 'audit.view'), wrap(async (req, res) => {
  const { businessId } = req.ctx;
  const since = new Date(Date.now() - 30 * 86400000);
  const [on, grants, [{ n: views }], [{ n: limited }]] = await Promise.all([
    privacy.isOn(businessId),
    knex('record_access_grants as g').leftJoin('users as u', 'u.id', 'g.user_id').leftJoin('patients as p', 'p.id', 'g.patient_id')
      .where('g.business_id', businessId).where('g.created_at', '>=', since).orderBy('g.created_at', 'desc').limit(20)
      .select('g.id', 'g.reason', 'g.created_at', 'g.expires_at', 'g.patient_id', 'u.name as user_name', 'p.full_name as patient_name'),
    knex('record_access_log').where({ business_id: businessId }).where('created_at', '>=', since).count({ n: '*' }),
    knex('record_access_log').where({ business_id: businessId, access: 'limited' }).where('created_at', '>=', since).count({ n: '*' }),
  ]);
  settingsCommon.render(req, res, 'privacy', 'privacy', { on, grants, views: Number(views), limited: Number(limited), now: new Date(), ...SETTINGS_ASSETS });
}));

router.post('/settings/privacy', can('settings.manage'), wrap(async (req, res) => {
  const on = req.body.clinical_privacy === '1';
  const before = await privacy.isOn(req.ctx.businessId);
  if (before !== on) {
    await knex('businesses').where({ id: req.ctx.businessId }).update({ clinical_privacy: on, updated_at: new Date() });
    businesses.forget(req.ctx.businessId);
    await audit.record(req.ctx, 'settings.record_privacy', { entityType: 'business', entityId: req.ctx.businessId, oldValues: { clinical_privacy: before }, newValues: { clinical_privacy: on } });
  }
  flash(req, 'success', req.t('privacy.saved'));
  res.redirect('/app/settings/privacy');
}));

function logFilters(req) {
  const q = req.query;
  const range = { from: lib.isIso(q.from) ? q.from : null, to: lib.isIso(q.to) ? q.to : null };
  const base = privacy.logQuery(req.ctx, q);
  if (range.from) base.where('l.created_at', '>=', lib.dayRange(range.from, range.from, req.ctx.timezone)[0]);
  if (range.to) base.where('l.created_at', '<', lib.dayRange(range.to, range.to, req.ctx.timezone)[1]);
  return base;
}
const LOG_SELECT = ['l.id', 'l.created_at', 'l.what', 'l.access', 'l.patient_id', 'l.appointment_id', 'l.ip', 'u.name as user_name', 'p.full_name as patient_name'];

router.get('/settings/privacy/log', can('audit.view'), wrap(async (req, res) => {
  const t = req.t;
  const stamp = (d) => { const lt = lib.localTime(d, req.ctx.timezone); return lt ? `${lt.date} ${lt.time}` : ''; };
  if (req.query.format) {
    const rows = await logFilters(req).orderBy('l.id', 'desc').limit(20000).select(LOG_SELECT);
    return exporter.send(req, res, {
      name: t('privacy.log_title'),
      header: [t('privacy.col_when'), t('privacy.col_who'), t('common.patient'), t('privacy.col_what'), t('privacy.col_access'), t('privacy.col_visit'), 'IP'],
      rows: rows.map((r) => [stamp(r.created_at), r.user_name || '', r.patient_name || '', t(`privacy.what.${r.what}`), t(`privacy.level.${r.access}`), r.appointment_id || '', r.ip || '']),
    });
  }
  const [{ rows, meta }, staff, patient] = await Promise.all([
    lib.paginate(logFilters(req).orderBy('l.id', 'desc').select(LOG_SELECT), { page: req.query.page, perPage: 50 }),
    knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where('m.business_id', req.ctx.businessId).orderBy('u.name').select('u.id', 'u.name'),
    /^\d+$/.test(req.query.patient || '') ? knex('patients').where({ id: Number(req.query.patient), business_id: req.ctx.businessId }).first('id', 'full_name') : null,
  ]);
  const filtered = ['user', 'patient', 'q', 'from', 'to', 'what'].some((k) => req.query[k]);
  settingsCommon.render(req, res, 'privacy-log', 'privacy', {
    title: t('privacy.log_title'), rows, meta, staff, patient, filtered, stamp, ...SETTINGS_ASSETS,
  });
}));

// ---------------------------------------------------------------- Settings → Diagnosis codes
const codesGate = canAny('settings.manage', 'clinical.edit');
async function renderCodes(req, res, extra = {}) {
  const q = String(req.query.q || '').trim();
  const qb = knex('icd_custom_codes').where({ business_id: req.ctx.businessId });
  if (q) qb.andWhere((w) => ['code', 'title_ar', 'title_en'].forEach((c) => w.orWhere(c, 'like', lib.likeTerm(q))));
  const since = lib.addDays(req.ctx.today, -365);
  const [rows, [{ n }], top] = await Promise.all([
    qb.orderBy('code').limit(500),
    knex('icd_custom_codes').where({ business_id: req.ctx.businessId }).count({ n: '*' }),
    knex('consultation_diagnoses as cd').join('appointments as a', 'a.id', 'cd.appointment_id').where('cd.business_id', req.ctx.businessId)
      .where('a.appointment_date', '>=', since).groupBy('cd.code').select('cd.code', knex.raw('MAX(cd.title_ar) as title_ar'), knex.raw('MAX(cd.title_en) as title_en'))
      .count({ n: '*' }).orderBy('n', 'desc').limit(10),
  ]);
  settingsCommon.render(req, res, 'diagnosis-codes', 'diagnosis_codes', {
    rows, totalAll: Number(n), top, source: icd.SOURCE, titleOf: (r) => icd.titleOf(r, req.locale), dxTable: icd.specialtyTable((req.business && req.business.specialty) || 'general'), ...SETTINGS_ASSETS, ...extra,
  });
}
const translateCodeError = (req, extra) => {
  if (extra.formError && extra.formError.code !== 'VALIDATION_FAILED') extra.formError.message = errText(req, extra.formError);
  return extra;
};
const rerenderCode = (req, res, extra) => renderCodes(req, res, { ...translateCodeError(req, extra), openDialog: 'icd-dialog', formAction: req.originalUrl });
router.get('/settings/diagnosis-codes', codesGate, wrap((req, res) => renderCodes(req, res)));
router.post('/settings/diagnosis-codes', codesGate, form(async (req, res) => {
  await icd.saveCustom(req.ctx, null, req.body);
  flash(req, 'success', req.t('icd.saved'));
  res.redirect('/app/settings/diagnosis-codes');
}, rerenderCode));
router.post('/settings/diagnosis-codes/:id(\\d+)', codesGate, form(async (req, res) => {
  await icd.saveCustom(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect('/app/settings/diagnosis-codes');
}, rerenderCode));
router.post('/settings/diagnosis-codes/:id(\\d+)/delete', codesGate, wrap(async (req, res) => {
  await icd.removeCustom(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/settings/diagnosis-codes');
}));

// ---------------------------------------------------------------- reports
const REPORT_ASSETS = { pageScripts: ['/js/records.js'], pageStyles: ['/css/records.css', '/css/clinicalplus.css'] };
const doctorsOf = (ctx) => knex('doctors').where({ business_id: ctx.businessId }).modify((q) => { if (ctx.ownDoctorId) q.where('id', ctx.ownDoctorId); })
  .orderBy([{ column: 'is_active', order: 'desc' }, { column: 'sort_order' }, { column: 'full_name' }]).select('id', 'full_name', 'full_name_en', 'color', 'slot_duration_minutes');
const doctorFilter = (req) => (req.ctx.ownDoctorId ? req.ctx.ownDoctorId : (/^\d+$/.test(req.query.doctor || '') ? Number(req.query.doctor) : null));
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

router.get('/reports/diagnoses', can('reports.view'), can('clinical.view'), wrap(async (req, res) => {
  const { ctx } = req; const t = req.t;
  const range = lib.resolveRange(req.query, ctx.today);
  const doctorId = doctorFilter(req);
  const base = () => knex('consultation_diagnoses as cd').join('appointments as a', 'a.id', 'cd.appointment_id')
    .where('cd.business_id', ctx.businessId).whereBetween('a.appointment_date', [range.from, range.to]).whereNot('a.status', 'cancelled')
    .modify((q) => { if (doctorId) q.where('a.doctor_id', doctorId); });
  const [codes, byDoc, docCodes, [totals], [{ n: completed }], doctors] = await Promise.all([
    base().groupBy('cd.code').select('cd.code', knex.raw('MAX(cd.title_ar) as title_ar'), knex.raw('MAX(cd.title_en) as title_en'))
      .count({ n: '*' }).select(knex.raw('COUNT(DISTINCT a.patient_id) as patients'), knex.raw('SUM(CASE WHEN cd.is_primary THEN 1 ELSE 0 END) as primaries'))
      .orderBy([{ column: 'n', order: 'desc' }, { column: 'cd.code' }]).limit(100),
    base().groupBy('a.doctor_id').select('a.doctor_id', knex.raw('COUNT(DISTINCT cd.appointment_id) as visits'), knex.raw('COUNT(DISTINCT a.patient_id) as patients')).count({ n: '*' }),
    base().groupBy('a.doctor_id', 'cd.code').select('a.doctor_id', 'cd.code').count({ n: '*' }),
    base().select(knex.raw('COUNT(DISTINCT cd.appointment_id) as visits'), knex.raw('COUNT(DISTINCT a.patient_id) as patients'), knex.raw('COUNT(DISTINCT cd.code) as codes'), knex.raw('COUNT(*) as n')),
    knex('appointments').where({ business_id: ctx.businessId, status: 'completed' }).whereBetween('appointment_date', [range.from, range.to])
      .modify((q) => { if (doctorId) q.where('doctor_id', doctorId); }).count({ n: '*' }),
    doctorsOf(ctx),
  ]);
  const title = (r) => icd.titleOf(r, req.locale);
  const docMap = new Map(doctors.map((d) => [d.id, d]));
  const codeTitle = new Map(codes.map((c) => [c.code, title(c)]));
  const perDoc = byDoc.map((r) => {
    const d = docMap.get(r.doctor_id);
    const top = docCodes.filter((x) => x.doctor_id === r.doctor_id).sort((x, y) => Number(y.n) - Number(x.n) || x.code.localeCompare(y.code)).slice(0, 3).map((x) => x.code);
    return { id: r.doctor_id, name: d ? docName(req, d) : t('icd.no_doctor'), color: d && d.color, visits: Number(r.visits), patients: Number(r.patients), codes: Number(r.n), top };
  }).sort((a, b) => b.visits - a.visits);
  const T = { visits: Number(totals.visits) || 0, patients: Number(totals.patients) || 0, codes: Number(totals.codes) || 0, n: Number(totals.n) || 0, completed: Number(completed) || 0 };
  const rows = codes.map((c) => ({ code: c.code, title: title(c), n: Number(c.n), patients: Number(c.patients), primaries: Number(c.primaries), share: T.n ? (Number(c.n) * 100) / T.n : 0 }));

  if (req.query.export) {
    const tables = {
      codes: { name: t('icd.report_title'), header: [t('icd.code'), t('icd.title_col'), t('icd.count'), t('icd.patients'), t('icd.as_primary'), `${t('icd.share')} %`],
        rows: rows.map((r) => [r.code, r.title, r.n, r.patients, r.primaries, r1(r.share)]) },
      doctors: { name: t('icd.by_doctor'), header: [t('common.doctor'), t('icd.coded_visits'), t('icd.patients'), t('icd.count'), t('icd.top_codes')],
        rows: perDoc.map((d) => [d.name, d.visits, d.patients, d.codes, d.top.join(', ')]) },
    };
    const tb = tables[req.query.export] || tables.codes;
    return exporter.send(req, res, { name: `${tb.name} ${range.from}_${range.to}`, header: tb.header, rows: tb.rows });
  }
  const nf = (v) => fmtCore.formatNumber(v, req.locale, 0);
  const chart = rows.length ? charts.bars({ items: rows.slice(0, 10).map((r) => ({ label: r.title, value: r.n, note: fmtCore.formatPercent(r.share, req.locale, 0) })), fmt: nf }) : null;
  return res.page('pages/clinicalplus/diagnoses-report', {
    title: t('icd.report_title'), range, months: monthsBack(ctx.today), doctors, doctorId, rows, perDoc, T, chart, codeTitle, printable: true, ...REPORT_ASSETS,
  });
}));

router.get('/reports/consultation-time', can('reports.view'), wrap(async (req, res) => {
  const { ctx } = req; const t = req.t;
  const range = lib.resolveRange(req.query, ctx.today);
  const doctorId = doctorFilter(req);
  const [timed, [{ n: completed }], doctors] = await Promise.all([
    knex('consultation_timers as ct').join('appointments as a', 'a.id', 'ct.appointment_id').leftJoin('services as s', 's.id', 'a.service_id').leftJoin('doctors as d', 'd.id', 'a.doctor_id')
      .where('ct.business_id', ctx.businessId).whereNotNull('ct.ended_at').whereBetween('a.appointment_date', [range.from, range.to])
      .modify((q) => { if (doctorId) q.where('a.doctor_id', doctorId); })
      .select('ct.started_at', 'ct.ended_at', 'ct.paused_seconds', 'a.doctor_id', 'a.service_id', 'a.duration_minutes', 's.duration_minutes as service_minutes', 's.name as service_name', 's.name_en as service_name_en',
        'd.slot_duration_minutes', 'd.full_name', 'd.full_name_en', 'd.color'),
    knex('appointments').where({ business_id: ctx.businessId, status: 'completed' }).whereNot('appointment_type', 'blocked').whereBetween('appointment_date', [range.from, range.to])
      .modify((q) => { if (doctorId) q.where('doctor_id', doctorId); }).count({ n: '*' }),
    doctorsOf(ctx),
  ]);
  // Readings under 30 seconds (started by mistake) or over 4 hours (never stopped) are left out.
  const items = []; let excluded = 0;
  timed.forEach((r) => {
    const minutes = timer.durationSeconds(r) / 60;
    if (minutes < 0.5 || minutes > 240) { excluded += 1; return; }
    items.push({ ...r, minutes, booked: Number(r.duration_minutes || r.service_minutes || r.slot_duration_minutes || 30) });
  });
  const summarise = (list) => {
    const mins = list.map((i) => i.minutes);
    const avg = mins.length ? mins.reduce((s, v) => s + v, 0) / mins.length : null;
    const booked = list.length ? list.reduce((s, i) => s + i.booked, 0) / list.length : null;
    const med = timer.median(mins);
    const suggest = timer.suggestSlot(med);
    return { n: list.length, avg: r1(avg), median: r1(med), booked: r1(booked), diff: avg !== null ? r1(avg - booked) : null, suggest, change: suggest && booked && Math.abs(suggest - booked) >= 5 };
  };
  const group = (keyFn, labelFn) => {
    const m = new Map();
    items.forEach((i) => { const k = keyFn(i); if (!m.has(k)) m.set(k, { label: labelFn(i), color: i.color, list: [] }); m.get(k).list.push(i); });
    return [...m.entries()].map(([k, g]) => ({ key: k, label: g.label, color: g.color, ...summarise(g.list) })).sort((a, b) => b.n - a.n);
  };
  const perDoctor = group((i) => i.doctor_id || 0, (i) => (i.doctor_id ? (req.locale === 'en' && i.full_name_en ? i.full_name_en : i.full_name) : t('icd.no_doctor')));
  const perService = group((i) => i.service_id || 0, (i) => (i.service_id ? (req.locale === 'en' && i.service_name_en ? i.service_name_en : i.service_name) : t('ctimer.general_visit')));
  const all = summarise(items);

  if (req.query.export) {
    const header = [t('ctimer.consultations'), t('ctimer.avg_actual'), t('ctimer.median_actual'), t('ctimer.avg_booked'), t('ctimer.difference'), t('ctimer.suggested')];
    const rowOf = (g) => [g.label, g.n, g.avg, g.median, g.booked, g.diff, g.suggest || ''];
    const tb = req.query.export === 'services'
      ? { name: t('ctimer.by_service'), header: [t('common.service'), ...header], rows: perService.map(rowOf) }
      : { name: t('ctimer.by_doctor'), header: [t('common.doctor'), ...header], rows: perDoctor.map(rowOf) };
    return exporter.send(req, res, { name: `${t('ctimer.report_title')} ${tb.name} ${range.from}_${range.to}`, header: tb.header, rows: tb.rows });
  }
  const mf = (v) => fmtCore.formatNumber(v, req.locale, 1);
  const chart = perDoctor.length ? charts.bars({ items: perDoctor.slice(0, 12).map((g) => ({ label: g.label, value: g.avg, note: t('ctimer.vs_booked', { n: mf(g.booked) }) })), fmt: mf }) : null;
  return res.page('pages/clinicalplus/consultation-time', {
    title: t('ctimer.report_title'), range, months: monthsBack(ctx.today), doctors, doctorId, perDoctor, perService, all, excluded, completed: Number(completed) || 0, chart, printable: true, ...REPORT_ASSETS,
  });
}));

module.exports = router;
