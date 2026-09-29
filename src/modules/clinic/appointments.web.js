// Appointments: day board per doctor, list + export, booking form with the live slot picker,
// appointment detail (status actions, assign doctor, follow-ups, delete) and doctor time blocks.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError, E } = require('../../core/errors');
const exporter = require('../../core/exporter');
const scheduling = require('./scheduling');
const appts = require('./appointments.service');
const doctorsSvc = require('./doctors.service');

const router = express.Router();
router.use(can('appointments.view'));

const ASSETS = { pageScripts: ['/js/appointments.js'], pageStyles: ['/css/appointments.css'] };

// ---------------------------------------------------------------- helpers
const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const errText = (req, e) => { const k = `errors.${e.code}`; const s = req.t(k); return s !== k ? s : e.message; };
const pickDate = (v, fallback) => (scheduling.isDate(v) ? v : fallback);
const safeReturn = (v) => (typeof v === 'string' && /^\/app\/[\w\-/?=&.%]*$/.test(v) && !v.startsWith('//') ? v : null);

/** Active doctors the current user may book for (a doctor login sees only their own). */
async function bookableDoctors(ctx) {
  const rows = await doctorsSvc.listActive(ctx);
  return ctx.ownDoctorId ? rows.filter((d) => d.id === ctx.ownDoctorId) : rows;
}

/** Length of each appointment: custom › service › doctor slot. */
async function lengths(ctx) {
  const [svcs, docs] = await Promise.all([
    knex('services').where({ business_id: ctx.businessId }).select('id', 'duration_minutes'),
    knex('doctors').where({ business_id: ctx.businessId }).select('id', 'slot_duration_minutes'),
  ]);
  const s = Object.fromEntries(svcs.map((x) => [x.id, x.duration_minutes]));
  const d = Object.fromEntries(docs.map((x) => [x.id, x.slot_duration_minutes]));
  return (a) => Number(a.duration_minutes || (a.service_id && s[a.service_id]) || (a.doctor_id && d[a.doctor_id]) || 30);
}

const withEnd = (lenOf) => (a) => ({ ...a, length: lenOf(a), end_time: scheduling.minutesToTime(Math.min(24 * 60 - 1, scheduling.timeToMinutes(a.appointment_time) + lenOf(a))) });

const filtersOf = (req) => ({
  doctor: req.ctx.ownDoctorId ? null : (Number(req.query.doctor) || null),
  status: appts.STATUSES.includes(req.query.status) ? req.query.status : null,
  q: String(req.query.q || '').trim().slice(0, 100) || null,
});

// ---------------------------------------------------------------- day board & list
async function renderIndex(req, res, extra = {}) {
  const { ctx } = req;
  const f = filtersOf(req);
  const view = req.query.view === 'list' ? 'list' : 'day';
  const doctors = await bookableDoctors(ctx);
  const lenOf = await lengths(ctx);
  const base = { title: req.t('appointments.title'), view, f, doctors, statuses: appts.STATUSES, ...ASSETS };

  if (view === 'list') {
    const from = pickDate(req.query.from, ctx.today);
    let to = pickDate(req.query.to, addDays(from, 6));
    if (to < from) to = from;
    const rows = (await appts.list(ctx, { from, to, doctor: f.doctor, status: f.status, q: f.q })).map(withEnd(lenOf));
    const totals = { count: rows.length, due: rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + Number(r.amount_due || 0), 0) };
    return res.page('pages/clinic/appointments/index', { ...base, from, to, rows, totals, capped: rows.length >= 1000, ...extra });
  }

  const date = pickDate(req.query.date, ctx.today);
  const filtered = Boolean(f.status || f.q);
  const all = (await appts.list(ctx, { from: date, to: date, doctor: f.doctor, status: f.status, q: f.q, includeBlocked: !filtered })).map(withEnd(lenOf));
  const off = await knex('doctor_days_off').where({ business_id: ctx.businessId, off_date: date }).pluck('doctor_id');
  const dayKey = scheduling.dayKeyOf(date);
  const shown = f.doctor ? doctors.filter((d) => d.id === f.doctor) : doctors;
  const columns = shown.map((d) => {
    const day = scheduling.normalizeDayConfig(doctorsSvc.parseWh(d.working_hours)[dayKey]);
    return { id: d.id, name: d.full_name, name_en: d.full_name_en, color: d.color, off: off.includes(d.id), works: day.enabled, shifts: day.shifts, breaks: day.breaks, items: all.filter((a) => a.doctor_id === d.id) };
  });
  // Appointments of an inactive/removed doctor or without a doctor still show up.
  const known = new Set(shown.map((d) => d.id));
  const orphans = all.filter((a) => !known.has(a.doctor_id) && (!f.doctor || a.doctor_id === f.doctor));
  const groups = {};
  orphans.forEach((a) => { const k = a.doctor_id || 0; (groups[k] = groups[k] || { id: a.doctor_id, name: a.doctor_name, name_en: a.doctor_name_en, color: a.doctor_color, works: true, shifts: [], breaks: [], items: [], unassigned: !a.doctor_id }).items.push(a); });
  Object.values(groups).forEach((g) => columns.push(g));
  const visits = all.filter((a) => a.appointment_type !== 'blocked');
  const stats = {
    total: visits.filter((a) => a.status !== 'cancelled').length,
    confirmed: visits.filter((a) => a.status === 'confirmed').length,
    pending: visits.filter((a) => a.status === 'pending').length,
    completed: visits.filter((a) => a.status === 'completed').length,
    missed: visits.filter((a) => a.status === 'no_show' || a.status === 'cancelled').length,
  };
  return res.page('pages/clinic/appointments/index', {
    ...base, date, prev: addDays(date, -1), next: addDays(date, 1), columns, stats, filtered, isPast: date < ctx.today, ...extra,
  });
}

router.get('/', wrap((req, res) => renderIndex(req, res)));

router.get('/export', can('data.export'), wrap(async (req, res) => {
  const { ctx } = req;
  const f = filtersOf(req);
  const from = pickDate(req.query.from || req.query.date, ctx.today);
  const to = pickDate(req.query.to || req.query.date, from);
  const lenOf = await lengths(ctx);
  const rows = await appts.list(ctx, { from, to: to < from ? from : to, doctor: f.doctor, status: f.status, q: f.q });
  const L = (ar, en) => (req.locale === 'en' && en ? en : ar);
  const t = (k) => req.t(k);
  exporter.send(req, res, {
    name: 'appointments', // ASCII: csv.js writes the file name into Content-Disposition as-is
    header: [t('common.date'), t('common.time'), t('appointments.duration'), t('common.patient'), t('common.phone'), t('common.doctor'), t('common.service'),
      t('common.status'), t('common.type'), t('appointments.source'), t('appointments.amount_due'), t('appointments.payment'), t('appointments.checked_in'), t('common.notes')],
    rows: rows.map((a) => [a.appointment_date, a.appointment_time, lenOf(a), a.patient_name, a.patient_phone || '', L(a.doctor_name, a.doctor_name_en) || '', L(a.service_name, a.service_name_en) || '',
      t(`appointments.statuses.${a.status}`), t(`appointments.types.${a.appointment_type}`), t(`appointments.sources.${a.source}`), Number(a.amount_due || 0),
      t(`appointments.payment_statuses.${a.payment_status}`), a.checked_in ? t('common.yes') : t('common.no'), a.notes || '']),
  });
}));

// Patient search for the booking form (clinic-scoped, max 8).
router.get('/patient-lookup', can('appointments.manage'), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return res.json({ data: [] });
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = await knex('patients').where({ business_id: req.ctx.businessId })
    .andWhere((w) => w.where('full_name', 'like', like).orWhere('phone', 'like', like))
    .orderBy('full_name').limit(8).select('id', 'full_name', 'phone', 'email', 'date_of_birth');
  return res.json({ data: rows.map((p) => ({ id: p.id, name: p.full_name, phone: p.phone || '', email: p.email || '', dob: p.date_of_birth || '' })) });
}));

// ---------------------------------------------------------------- time blocks
router.post('/blocks', can('appointments.manage'), form(async (req, res) => {
  if (req.ctx.ownDoctorId && Number(req.body.doctor_id) !== req.ctx.ownDoctorId) throw E.forbidden('appointments.view_all');
  await appts.block(req.ctx, req.body);
  flash(req, 'success', req.t('appointments.block_saved'));
  res.redirect(`/app/appointments?date=${encodeURIComponent(req.body.appointment_date)}`);
}, (req, res, extra) => {
  req.query = { date: scheduling.isDate(req.body.appointment_date) ? req.body.appointment_date : undefined };
  return renderIndex(req, res, { ...extra, openDialog: 'block-dialog' });
}));

router.post('/blocks/:id(\\d+)/delete', can('appointments.manage'), wrap(async (req, res) => {
  const a = await appts.get(req.ctx, Number(req.params.id));
  if (a.appointment_type !== 'blocked') throw E.notFound('Appointment');
  await appts.remove(req.ctx, a.id);
  flash(req, 'success', req.t('appointments.block_deleted'));
  res.redirect(`/app/appointments?date=${a.appointment_date}`);
}));

// ---------------------------------------------------------------- booking form
async function renderForm(req, res, extra = {}) {
  const { ctx } = req;
  const appt = req.params.id ? await appts.get(ctx, Number(req.params.id)) : null;
  if (appt && appt.appointment_type === 'blocked') throw E.notFound('Appointment');
  const doctors = await bookableDoctors(ctx);
  const q = req.query;
  let v;
  if (appt) {
    v = {
      doctor_id: appt.doctor_id || '', service_id: appt.service_id || '', patient_id: appt.patient_id || '', patient_name: appt.patient_name, patient_phone: appt.patient_phone || '',
      patient_email: appt.patient_email || '', appointment_date: appt.appointment_date, appointment_time: appt.appointment_time, duration_minutes: appt.duration_minutes || '',
      appointment_type: appt.appointment_type, status: appt.status, notes: appt.notes || '',
    };
  } else {
    const docId = ctx.ownDoctorId || Number(q.doctor) || (doctors.length ? doctors[0].id : '');
    v = {
      doctor_id: doctors.some((d) => d.id === Number(docId)) ? Number(docId) : '', service_id: Number(q.service) || '', patient_id: '', patient_name: '', patient_phone: '', patient_email: '',
      appointment_date: q.date === 'today' ? ctx.today : (scheduling.isDate(q.date) && q.date >= ctx.today ? q.date : ctx.today),
      appointment_time: scheduling.isTime(q.time) ? q.time : '', duration_minutes: '', appointment_type: 'in_person', status: 'confirmed', notes: '',
    };
    if (Number(q.patient)) {
      const p = await knex('patients').where({ business_id: ctx.businessId, id: Number(q.patient) }).first('id', 'full_name', 'phone', 'email');
      if (p) Object.assign(v, { patient_id: p.id, patient_name: p.full_name, patient_phone: p.phone || '', patient_email: p.email || '' });
    }
  }
  if (extra.old) Object.keys(v).forEach((k) => { if (extra.old[k] !== undefined) v[k] = extra.old[k]; });
  const services = await doctorsSvc.servicesFor(ctx, v.doctor_id ? Number(v.doctor_id) : null);
  res.page('pages/clinic/appointments/form', {
    title: appt ? req.t('appointments.edit') : req.t('appointments.new'), appt, doctors, services, v,
    returnTo: safeReturn(q.return || (extra.old && extra.old.return_to)), ...ASSETS, ...extra,
  });
}

router.get('/new', can('appointments.manage'), wrap((req, res) => renderForm(req, res)));
router.post('/new', can('appointments.manage'), form(async (req, res) => {
  const id = await appts.book(req.ctx, req.body, { source: 'staff' });
  flash(req, 'success', req.t('appointments.booked'));
  res.redirect(safeReturn(req.body.return_to) || `/app/appointments/${id}`);
}, renderForm));

router.get('/:id(\\d+)/edit', can('appointments.manage'), wrap((req, res) => renderForm(req, res)));
router.post('/:id(\\d+)/edit', can('appointments.manage'), form(async (req, res) => {
  await appts.update(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('appointments.updated'));
  res.redirect(safeReturn(req.body.return_to) || `/app/appointments/${req.params.id}`);
}, renderForm));

// ---------------------------------------------------------------- detail
async function renderShow(req, res, extra = {}) {
  const { ctx } = req;
  const a = await appts.get(ctx, Number(req.params.id));
  if (a.appointment_type === 'blocked') return res.redirect(`/app/appointments?date=${a.appointment_date}`);
  const lenOf = await lengths(ctx);
  const [invoice, children, parent, doctors, patient, consult] = await Promise.all([
    knex('invoices').where({ business_id: ctx.businessId, appointment_id: a.id }).first('id', 'invoice_number', 'amount', 'payment_method', 'discount_percent', 'created_at'),
    knex('appointments').where({ business_id: ctx.businessId, parent_appointment_id: a.id }).orderBy([{ column: 'appointment_date' }, { column: 'appointment_time' }]).select('id', 'appointment_date', 'appointment_time', 'status'),
    a.parent_appointment_id ? knex('appointments').where({ business_id: ctx.businessId, id: a.parent_appointment_id }).first('id', 'appointment_date', 'appointment_time') : null,
    bookableDoctors(ctx),
    a.patient_id ? knex('patients').where({ business_id: ctx.businessId, id: a.patient_id }).first('id', 'full_name', 'date_of_birth', 'gender') : null,
    knex('consultations').where({ business_id: ctx.businessId, appointment_id: a.id }).first('id', 'diagnosis'),
  ]);
  return res.page('pages/clinic/appointments/show', {
    title: `${a.patient_name} · ${a.appointment_date}`, a: { ...a, length: lenOf(a), end_time: withEnd(lenOf)(a).end_time }, invoice, children, parent, doctors, patient, consult,
    followDate: a.appointment_date >= ctx.today ? addDays(a.appointment_date, 7) : addDays(ctx.today, 7), ...ASSETS, ...extra,
  });
}

router.get('/:id(\\d+)', wrap((req, res) => renderShow(req, res)));

router.post('/:id(\\d+)/status', can('appointments.manage'), wrap(async (req, res) => {
  const status = String(req.body.status || '');
  await appts.setStatus(req.ctx, Number(req.params.id), status);
  flash(req, 'success', req.t('appointments.status_changed', { status: req.t(`appointments.statuses.${status}`) }));
  res.redirect(safeReturn(req.body.return_to) || `/app/appointments/${req.params.id}`);
}));

router.post('/:id(\\d+)/assign', can('appointments.manage'), wrap(async (req, res) => {
  try {
    const doctorId = Number(req.body.doctor_id);
    if (!doctorId || (req.ctx.ownDoctorId && doctorId !== req.ctx.ownDoctorId)) throw E.validation({ doctor_id: 'Choose a valid value.' });
    await appts.assignDoctor(req.ctx, Number(req.params.id), doctorId);
    flash(req, 'success', req.t('appointments.doctor_assigned'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 403) throw e;
    flash(req, 'error', errText(req, e));
  }
  res.redirect(`/app/appointments/${req.params.id}`);
}));

router.post('/:id(\\d+)/follow-up', can('appointments.manage'), form(async (req, res) => {
  const id = await appts.followUp(req.ctx, Number(req.params.id), {
    appointment_date: req.body.appointment_date, appointment_time: req.body.appointment_time, appointment_type: req.body.appointment_type,
    notes: req.body.notes || req.t('appointments.follow_up_note'),
  });
  flash(req, 'success', req.t('appointments.follow_up_booked'));
  res.redirect(`/app/appointments/${id}`);
}, (req, res, extra) => renderShow(req, res, { ...extra, openDialog: 'followup-dialog' })));

router.post('/:id(\\d+)/delete', can('appointments.manage'), wrap(async (req, res) => {
  const a = await appts.get(req.ctx, Number(req.params.id));
  try {
    await appts.remove(req.ctx, a.id);
  } catch (e) {
    if (!(e instanceof AppError) || e.status !== 409) throw e;
    flash(req, 'error', errText(req, e));
    return res.redirect(`/app/appointments/${a.id}`);
  }
  flash(req, 'success', req.t('appointments.deleted'));
  return res.redirect(`/app/appointments?date=${a.appointment_date}`);
}));

module.exports = router;
