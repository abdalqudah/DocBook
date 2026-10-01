// Appointments: day board per doctor, list + export, booking form with the live slot picker,
// appointment detail (status actions, assign doctor, follow-ups, delete) and doctor time blocks.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError, E } = require('../../core/errors');
const exporter = require('../../core/exporter');
const { translateMessage } = require('../../core/i18n');
const scheduling = require('./scheduling');
const appts = require('./appointments.service');
const branchesSvc = require('./branches.service');
const doctorsSvc = require('./doctors.service');
const payParts = require('./payment-parts');

const router = express.Router();
router.use(can('appointments.view'));

const ASSETS = { pageScripts: ['/js/appointments.js', '/js/peek.js'], pageStyles: ['/css/appointments.css'] };

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
  type: ['online', 'in_person'].includes(req.query.type) ? req.query.type : null, // Online consultations filter
  branch: req.query.branch === 'main' ? 'main' : (Number(req.query.branch) || null), // clinics with branches
});
// Branch choices for the filters (null when the clinic runs only its main branch).
const branchFilter = async (req) => ((await branchesSvc.multi(req.ctx.businessId)) ? branchesSvc.options(req.business, req.t, req.locale, { includeInactive: true }) : null);
const inBranch = (f) => (d) => !f.branch || (f.branch === 'main' ? !d.branch_id : d.branch_id === f.branch);

// ---------------------------------------------------------------- calendar (day / week) & list
const T = scheduling.timeToMinutes;
const QUARTER = 15;

/** Working intervals of a day: shifts minus breaks, in minutes. */
function workIntervals(day) {
  let out = day.shifts.map((s) => [T(s.start), T(s.end)]);
  day.breaks.forEach((b) => {
    const bs = T(b.start); const be = T(b.end);
    out = out.flatMap(([s, e]) => (be <= s || bs >= e ? [[s, e]] : [[s, Math.min(bs, e)], [Math.max(be, s), e]].filter(([x, y]) => y > x)));
  });
  return out.sort((x, y) => x[0] - y[0]);
}

/** Side-by-side lanes for overlapping items of one column (greedy, per overlapping cluster). */
function layoutLanes(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.len - a.len);
  let cluster = []; let clusterEnd = -1;
  const flush = () => { const n = Math.max(1, ...cluster.map((i) => i.lane + 1)); cluster.forEach((i) => { i.lanes = n; }); cluster = []; };
  sorted.forEach((it) => {
    if (cluster.length && it.start >= clusterEnd) flush();
    const lanesEnd = [];
    cluster.forEach((c) => { lanesEnd[c.lane] = Math.max(lanesEnd[c.lane] || 0, c.start + c.len); });
    let lane = lanesEnd.findIndex((e) => e <= it.start);
    if (lane < 0) lane = lanesEnd.length;
    it.lane = lane;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.start + it.len);
  });
  if (cluster.length) flush();
  return sorted;
}

/** One calendar column (a doctor on a date): schedule, non-working ranges and positioned items. */
function buildColumn({ key, doctor, date, off, items, lenOf, showCancelled, orphan }) {
  const day = doctor && !orphan ? scheduling.normalizeDayConfig(doctorsSvc.parseWh(doctor.working_hours)[scheduling.dayKeyOf(date)]) : { enabled: false, shifts: [], breaks: [] };
  const works = day.enabled && !off;
  const evs = items.filter((a) => showCancelled || a.status !== 'cancelled').map((a) => {
    const len = lenOf(a);
    return {
      id: a.id, blocked: a.appointment_type === 'blocked', status: a.status, start: T(a.appointment_time), len, time: a.appointment_time,
      end: scheduling.minutesToTime(Math.min(24 * 60 - 1, T(a.appointment_time) + len)), patient: a.patient_name, label: a.notes, service: a.service_name, service_en: a.service_name_en,
      online: a.appointment_type === 'online', website: a.source === 'website', paid: a.payment_status === 'paid', checked_in: a.checked_in, with_doctor: a.with_doctor,
      movable: Boolean(a.doctor_id) && a.status !== 'cancelled' && a.payment_status !== 'paid',
    };
  });
  return {
    key, date, doctorId: doctor ? doctor.id : null, name: doctor ? doctor.full_name : null, name_en: doctor ? doctor.full_name_en : null, color: doctor ? doctor.color : null,
    slot: (doctor && doctor.slot_duration_minutes) || 30, off, works, orphan: Boolean(orphan), shifts: day.shifts, breaks: day.breaks,
    work: works ? workIntervals(day) : [], shiftMins: works ? day.shifts.map((x) => [T(x.start), T(x.end)]) : [], items: layoutLanes(evs),
    busy: items.filter((a) => a.status !== 'cancelled').map((a) => [T(a.appointment_time), T(a.appointment_time) + lenOf(a), a.id]),
  };
}

/** Visible time range: earliest shift start → latest shift end (whole hours), widened to fit every item. */
function gridRange(columns) {
  let lo = Infinity; let hi = -Infinity;
  columns.forEach((c) => {
    c.work.forEach(([s, e]) => { lo = Math.min(lo, s); hi = Math.max(hi, e); });
    c.shifts.forEach((s) => { if (c.works) { lo = Math.min(lo, T(s.start)); hi = Math.max(hi, T(s.end)); } });
  });
  if (!Number.isFinite(lo)) { lo = 8 * 60; hi = 20 * 60; }
  columns.forEach((c) => c.items.forEach((i) => { lo = Math.min(lo, i.start); hi = Math.max(hi, i.start + i.len); }));
  lo = Math.max(0, Math.floor(lo / 60) * 60);
  hi = Math.min(24 * 60, Math.ceil(hi / 60) * 60);
  if (hi - lo < 60) hi = Math.min(24 * 60, lo + 60);
  return { start: lo, end: hi };
}

/** Non-working ranges of a column inside the visible range (shaded on the grid). */
function offRanges(col, range) {
  if (col.orphan) return [];
  if (!col.works) return [[range.start, range.end]];
  const out = []; let cur = range.start;
  col.work.forEach(([s, e]) => { if (s > cur) out.push([cur, Math.min(s, range.end)]); cur = Math.max(cur, e); });
  if (cur < range.end) out.push([cur, range.end]);
  return out.filter(([s, e]) => e > s);
}

/** Saturday that starts the clinic week containing `date`. */
const weekStart = (date) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 1) % 7));

async function renderIndex(req, res, extra = {}) {
  const { ctx } = req;
  const f = filtersOf(req);
  const view = ['list', 'week'].includes(req.query.view) ? req.query.view : 'day';
  const branchOpts = await branchFilter(req);
  if (!branchOpts) f.branch = null;
  const doctors = (await bookableDoctors(ctx)).filter(inBranch(f));
  const lenOf = await lengths(ctx);
  const base = { title: req.t('appointments.title'), view, f, doctors, statuses: appts.STATUSES, branchOpts, ...ASSETS };

  if (view === 'list') {
    const from = pickDate(req.query.from, ctx.today);
    let to = pickDate(req.query.to, addDays(from, 6));
    if (to < from) to = from;
    const rows = (await appts.list(ctx, { from, to, doctor: f.doctor, status: f.status, q: f.q, type: f.type, branch: f.branch })).map(withEnd(lenOf));
    const totals = { count: rows.length, due: rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + Number(r.amount_due || 0), 0) };
    return res.page('pages/clinic/appointments/index', { ...base, from, to, rows, totals, capped: rows.length >= 1000, ...extra });
  }

  const date = pickDate(req.query.date, ctx.today);
  const showCancelled = req.query.cancelled === '1';
  const now = scheduling.clinicNow(ctx.timezone);
  let columns = []; let days = []; let weekDoctor = null;
  let all;
  if (view === 'week') {
    weekDoctor = doctors.find((d) => d.id === (ctx.ownDoctorId || f.doctor)) || doctors[0] || null;
    const from = weekStart(date);
    days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    all = weekDoctor ? await appts.list(ctx, { from: days[0], to: days[6], doctor: weekDoctor.id, includeBlocked: true, type: f.type }) : [];
    const off = weekDoctor ? await knex('doctor_days_off').where({ business_id: ctx.businessId, doctor_id: weekDoctor.id }).whereBetween('off_date', [days[0], days[6]]).pluck('off_date') : [];
    const offSet = new Set(off.map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))));
    if (weekDoctor) columns = days.map((d) => buildColumn({ key: d, doctor: weekDoctor, date: d, off: offSet.has(d), items: all.filter((a) => a.appointment_date === d), lenOf, showCancelled }));
  } else {
    all = await appts.list(ctx, { from: date, to: date, doctor: f.doctor, includeBlocked: true, type: f.type, branch: f.branch });
    const off = await knex('doctor_days_off').where({ business_id: ctx.businessId, off_date: date }).pluck('doctor_id');
    const shown = f.doctor ? doctors.filter((d) => d.id === f.doctor) : doctors;
    columns = shown.map((d) => buildColumn({ key: `d${d.id}`, doctor: d, date, off: off.includes(d.id), items: all.filter((a) => a.doctor_id === d.id), lenOf, showCancelled }));
    // Appointments of an inactive/removed doctor or without a doctor still show up (read-only columns).
    const known = new Set(shown.map((d) => d.id));
    const groups = {};
    all.filter((a) => !known.has(a.doctor_id) && (!f.doctor || a.doctor_id === f.doctor)).forEach((a) => {
      const k = a.doctor_id || 0;
      (groups[k] = groups[k] || { doctor: a.doctor_id ? { id: a.doctor_id, full_name: a.doctor_name, full_name_en: a.doctor_name_en, color: a.doctor_color } : null, items: [] }).items.push(a);
    });
    Object.entries(groups).forEach(([k, g]) => columns.push({ ...buildColumn({ key: `o${k}`, doctor: g.doctor, date, off: false, items: g.items, lenOf, showCancelled, orphan: true }), unassigned: !g.doctor }));
  }
  const range = gridRange(columns);
  columns.forEach((c) => { c.offRanges = offRanges(c, range); });
  const visits = all.filter((a) => a.appointment_type !== 'blocked');
  const stats = {
    total: visits.filter((a) => a.status !== 'cancelled').length,
    pending: visits.filter((a) => a.status === 'pending').length,
    completed: visits.filter((a) => a.status === 'completed').length,
    missed: visits.filter((a) => a.status === 'no_show' || a.status === 'cancelled').length,
    blocks: all.filter((a) => a.appointment_type === 'blocked').length,
  };
  const step = view === 'week' ? 7 : 1;
  return res.page('pages/clinic/appointments/index', {
    ...base, date, prev: addDays(date, -step), next: addDays(date, step), columns, days, weekDoctor, range, stats, showCancelled,
    now, isPast: date < ctx.today, ...extra,
  });
}

router.get('/', wrap((req, res) => renderIndex(req, res)));

router.get('/export', can('data.export'), wrap(async (req, res) => {
  const { ctx } = req;
  const f = filtersOf(req);
  const from = pickDate(req.query.from || req.query.date, ctx.today);
  const to = pickDate(req.query.to || req.query.date, from);
  const lenOf = await lengths(ctx);
  const rows = await appts.list(ctx, { from, to: to < from ? from : to, doctor: f.doctor, status: f.status, q: f.q, type: f.type, branch: f.branch });
  const L = (ar, en) => (req.locale === 'en' && en ? en : ar);
  const t = (k) => req.t(k);
  exporter.send(req, res, {
    name: 'appointments', // ASCII: csv.js writes the file name into Content-Disposition as-is
    header: [t('common.date'), t('common.time'), t('appointments.duration'), t('common.patient'), t('common.phone'), t('common.doctor'), t('common.service'),
      t('common.status'), t('common.type'), t('appointments.source'), t('appointments.amount_due'), t('appointments.payment'), t('appointments.checked_in'), t('common.notes')],
    rows: rows.map((a) => [a.appointment_date, a.appointment_time, lenOf(a), a.patient_name, a.patient_phone || '', L(a.doctor_name, a.doctor_name_en) || '', L(a.service_name, a.service_name_en) || '',
      t(`appointments.statuses.${a.status}`), t(`appointments.types.${a.appointment_type}`), (a.source === 'import' ? t('calimport.source_label') : t(`appointments.sources.${a.source}`)), Number(a.amount_due || 0),
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
  res.redirect(safeReturn(req.body.return_to) || `/app/appointments?date=${encodeURIComponent(req.body.appointment_date)}`);
}, (req, res, extra) => {
  const back = new URLSearchParams(String(safeReturn(req.body.return_to) || '').split('?')[1] || '');
  req.query = { view: back.get('view') || undefined, doctor: back.get('doctor') || undefined, date: scheduling.isDate(req.body.appointment_date) ? req.body.appointment_date : undefined };
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
      appointment_time: scheduling.isTime(q.time) ? q.time : '',
      duration_minutes: Number.isInteger(Number(q.duration)) && Number(q.duration) >= scheduling.MIN_BLOCK_MINUTES && Number(q.duration) <= scheduling.MAX_BLOCK_MINUTES ? Number(q.duration) : '', appointment_type: 'in_person', status: 'confirmed', notes: '',
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
    knex('invoices').where({ business_id: ctx.businessId, appointment_id: a.id }).first('id', 'invoice_number', 'amount', 'payment_method', 'discount_percent', 'created_at', 'insurance_provider_name'),
    knex('appointments').where({ business_id: ctx.businessId, parent_appointment_id: a.id }).orderBy([{ column: 'appointment_date' }, { column: 'appointment_time' }]).select('id', 'appointment_date', 'appointment_time', 'status'),
    a.parent_appointment_id ? knex('appointments').where({ business_id: ctx.businessId, id: a.parent_appointment_id }).first('id', 'appointment_date', 'appointment_time') : null,
    bookableDoctors(ctx),
    a.patient_id ? knex('patients').where({ business_id: ctx.businessId, id: a.patient_id }).first('id', 'full_name', 'date_of_birth', 'gender') : null,
    knex('consultations').where({ business_id: ctx.businessId, appointment_id: a.id }).first('id', 'diagnosis'),
  ]);
  if (invoice) await payParts.attach(ctx.businessId, [invoice]); // how it was paid (parts), never "mixed"
  const online = await require('../telehealth/web').panelData(req, a); // eslint-disable-line global-require
  const multiBranch = await branchesSvc.multi(ctx.businessId);
  return res.page('pages/clinic/appointments/show', {
    multiBranch, title: `${a.patient_name} · ${a.appointment_date}`, a: { ...a, length: lenOf(a), end_time: withEnd(lenOf)(a).end_time }, invoice, children, parent, doctors, patient, consult, online,
    followDate: a.appointment_date >= ctx.today ? addDays(a.appointment_date, 7) : addDays(ctx.today, 7), ...ASSETS,
    ...(online ? { pageScripts: [...ASSETS.pageScripts, '/js/telehealth.js'], pageStyles: [...ASSETS.pageStyles, '/css/telehealth.css'] } : {}), ...extra,
  });
}

router.get('/:id(\\d+)', wrap((req, res) => renderShow(req, res)));

// Appointment drawer (Appointments page): the essentials and the next actions, without leaving the list or calendar.
// A fragment (no layout); every action goes to the existing endpoints and comes back to `return` (a safe /app path).
router.get('/:id(\\d+)/peek', wrap(async (req, res) => {
  const { ctx } = req;
  const a = await appts.get(ctx, Number(req.params.id));
  if (a.appointment_type === 'blocked') throw E.notFound('Appointment');
  const [doctor, service, invoice] = await Promise.all([
    a.doctor_id ? knex('doctors').where({ business_id: ctx.businessId, id: a.doctor_id }).first('full_name', 'full_name_en', 'color') : null,
    a.service_id ? knex('services').where({ business_id: ctx.businessId, id: a.service_id }).first('name', 'name_en') : null,
    knex('invoices').where({ business_id: ctx.businessId, appointment_id: a.id }).first('id', 'invoice_number', 'amount'),
  ]);
  // A booking waiting for confirmation: reception picks the doctor (when the patient chose "any doctor") and confirms.
  let doctorsList = a.status === 'pending' && ctx.permissions.has('appointments.manage')
    ? await knex('doctors').where({ business_id: ctx.businessId, is_active: true }).modify((q) => { if (ctx.ownDoctorId) q.where('id', ctx.ownDoctorId); }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }]).select('id', 'full_name', 'full_name_en', 'branch_id')
    : [];
  // A booking without a doctor was made for a branch: offer that branch's doctors (all of them if it has none).
  if (!a.doctor_id && doctorsList.length) { const here = doctorsList.filter((d) => (d.branch_id || null) === (a.branch_id || null)); if (here.length) doctorsList = here; }
  const multiBranch = await branchesSvc.multi(ctx.businessId);
  res.set('Cache-Control', 'no-store');
  return res.render('pages/clinic/appointments/_peek', { ...res.locals, a, doctor, service, invoice, doctorsList, multiBranch, back: safeReturn(req.query.return) || '/app/appointments', isToday: a.appointment_date === ctx.today });
}));

router.post('/:id(\\d+)/status', can('appointments.manage'), wrap(async (req, res) => {
  const status = String(req.body.status || '');
  await appts.setStatus(req.ctx, Number(req.params.id), status);
  flash(req, 'success', req.t('appointments.status_changed', { status: req.t(`appointments.statuses.${status}`) }));
  res.redirect(safeReturn(req.body.return_to) || `/app/appointments/${req.params.id}`);
}));

router.post('/:id(\\d+)/confirm', can('appointments.manage'), wrap(async (req, res) => {
  const back = safeReturn(req.body.return_to) || `/app/appointments/${req.params.id}`;
  try {
    const doctorId = Number(req.body.doctor_id) || null;
    if (doctorId && req.ctx.ownDoctorId && doctorId !== req.ctx.ownDoctorId) throw E.forbidden('appointments.view_all');
    await appts.confirm(req.ctx, Number(req.params.id), { doctor_id: doctorId, appointment_date: req.body.appointment_date || undefined, appointment_time: req.body.appointment_time || undefined });
    flash(req, 'success', req.t('appointments.confirmed_sent'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 403) throw e;
    flash(req, 'error', errText(req, e));
  }
  res.redirect(back);
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

// Calendar drag-and-drop (JSON): move to another time/date/doctor; the slot is re-validated server-side.
router.post('/:id(\\d+)/move', can('appointments.manage'), wrap(async (req, res) => {
  try {
    await appts.move(req.ctx, Number(req.params.id), { doctor_id: req.body.doctor_id, appointment_date: req.body.appointment_date, appointment_time: req.body.appointment_time });
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    const field = e.details && typeof e.details === 'object' ? Object.values(e.details).find((v) => typeof v === 'string') : null;
    // 200 + ok:false keeps an expected refusal (e.g. SLOT_TAKEN) out of the browser console as a failed request.
    return res.json({ ok: false, status: e.status, error: e.code === 'VALIDATION_FAILED' && field ? translateMessage(req.locale, field) : errText(req, e), code: e.code });
  }
  flash(req, 'success', req.t('appointments.cal.moved'));
  return res.json({ ok: true });
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
