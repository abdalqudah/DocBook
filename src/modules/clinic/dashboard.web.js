// Clinic dashboard (GET /app) and a doctor's own day (GET /app/my-day).
const express = require('express');
const knex = require('../../db/knex');
const charts = require('../../core/charts');
const fmtCore = require('../../core/format');
const { E } = require('../../core/errors');
const { wrap } = require('../../routes/helpers');
const { entryFor } = require('../rbac/permissions');
const scheduling = require('./scheduling');
const lib = require('./records.lib');

const router = express.Router();
const PAGE = { pageScripts: ['/js/records.js'], pageStyles: ['/css/records.css'] };
const ACTIVE = ['pending', 'confirmed'];

const apptBase = (ctx) => {
  const q = knex('appointments as a').where('a.business_id', ctx.businessId).whereNot('a.appointment_type', 'blocked');
  if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId);
  return q;
};
const invBase = (ctx) => {
  const q = knex('invoices as i').where('i.business_id', ctx.businessId);
  if (ctx.ownDoctorId) q.where('i.doctor_id', ctx.ownDoctorId);
  return q;
};
const sumOf = async (q) => { const [r] = await q.select(knex.raw('COALESCE(SUM(i.amount),0) as v'), knex.raw('COUNT(*) as n')); return { value: Number(r.v) || 0, count: Number(r.n) || 0 }; };

function greetingKey(tz) {
  const { minutes } = scheduling.clinicNow(tz);
  if (minutes < 12 * 60) return 'dashboard.greet_morning';
  if (minutes < 17 * 60) return 'dashboard.greet_afternoon';
  return 'dashboard.greet_evening';
}

/** Where someone without the dashboard goes (never back to /app itself). */
function fallbackFor(req, res) {
  const entry = entryFor(req.ctx.roleKey);
  if (entry && entry !== '/app' && entry !== '/app/') {
    if (entry === '/app/my-day' && !req.ctx.doctorId) return null;
    return entry;
  }
  if (req.ctx.doctorId) return '/app/my-day';
  const first = (res.locals.navGroups || []).flatMap((g) => g.items).find((i) => i.href !== '/app' && i.href !== '/app/settings' && i.href !== '/app/help');
  return first ? first.href : null;
}

router.get('/', wrap(async (req, res) => {
  const { ctx } = req;
  const perms = ctx.permissions;
  if (!perms.has('dashboard.view')) {
    const to = fallbackFor(req, res);
    if (to) return res.redirect(to);
    return res.redirect('/app/settings');
  }
  const today = ctx.today;
  const tz = ctx.timezone;
  const finance = perms.has('finance.view');
  const month = today.slice(0, 7);
  const lastMonth = lib.addMonths(month, -1);
  const dayOfMonth = Number(today.slice(8, 10));
  const lastMonthBounds = lib.monthBounds(lastMonth);
  const lastMonthSameDay = `${lastMonth}-${String(Math.min(dayOfMonth, Number(lastMonthBounds.to.slice(8, 10)))).padStart(2, '0')}`;
  const from30 = lib.addDays(today, -29);

  const [statusRows, waitingRow, withDoctorRow, schedule, pendingOnline, pendingCount, perDay, setup, lowStock, upcomingCount] = await Promise.all([
    apptBase(ctx).where('a.appointment_date', today).groupBy('a.status').select('a.status').count({ n: '*' }),
    apptBase(ctx).where({ 'a.appointment_date': today, 'a.checked_in': true, 'a.with_doctor': false }).whereIn('a.status', ACTIVE).count({ n: '*' }).first(),
    apptBase(ctx).where({ 'a.appointment_date': today, 'a.with_doctor': true }).whereIn('a.status', ACTIVE).count({ n: '*' }).first(),
    apptBase(ctx).leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id').where('a.appointment_date', today)
      .orderBy('a.appointment_time').limit(60).select('a.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.color as doctor_color', 's.name as service_name', 's.name_en as service_name_en'),
    apptBase(ctx).leftJoin('doctors as d', 'd.id', 'a.doctor_id').where({ 'a.source': 'website', 'a.status': 'pending' }).where('a.appointment_date', '>=', today)
      .orderBy([{ column: 'a.appointment_date' }, { column: 'a.appointment_time' }]).limit(6).select('a.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.color as doctor_color'),
    apptBase(ctx).where({ 'a.source': 'website', 'a.status': 'pending' }).where('a.appointment_date', '>=', today).count({ n: '*' }).first(),
    apptBase(ctx).whereBetween('a.appointment_date', [from30, today]).whereNot('a.status', 'cancelled').groupBy('a.appointment_date').select('a.appointment_date as d').count({ n: '*' })
      .select(knex.raw("SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as done")),
    Promise.all([
      knex('doctors').where({ business_id: ctx.businessId, is_active: true }).count({ n: '*' }).first(),
      knex('services').where({ business_id: ctx.businessId, is_active: true }).count({ n: '*' }).first(),
    ]),
    perms.has('supplies.view') ? knex('supply_items').where({ business_id: ctx.businessId }).whereRaw('current_stock <= reorder_level').count({ n: '*' }).first() : null,
    apptBase(ctx).whereBetween('a.appointment_date', [lib.addDays(today, 1), lib.addDays(today, 7)]).whereIn('a.status', ACTIVE).count({ n: '*' }).first(),
  ]);

  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.n)]));
  const kpi = {
    today: Object.entries(byStatus).filter(([s]) => s !== 'cancelled').reduce((s, [, n]) => s + n, 0),
    cancelled: byStatus.cancelled || 0,
    waiting: Number(waitingRow.n) || 0,
    withDoctor: Number(withDoctorRow.n) || 0,
    completed: byStatus.completed || 0,
    noShows: byStatus.no_show || 0,
    remaining: schedule.filter((a) => ACTIVE.includes(a.status) && !a.checked_in).length,
    upcoming: Number(upcomingCount.n) || 0,
  };

  // Last 30 days of appointments (every day shown, zero days included).
  const counts = Object.fromEntries(perDay.map((r) => [r.d, { n: Number(r.n), done: Number(r.done) }]));
  const L = (d, o) => fmtCore.formatDate(d, req.locale, o);
  const points = [];
  for (let i = 0; i < 30; i += 1) {
    const d = lib.addDays(from30, i);
    points.push({ label: L(d, { weekday: 'short', day: 'numeric', month: 'short' }), short: L(d, { day: 'numeric', month: 'numeric' }), value: (counts[d] || {}).n || 0, done: (counts[d] || {}).done || 0 });
  }
  const nf = (v) => fmtCore.formatNumber(v, req.locale, 0);
  const apptChart = points.some((p) => p.value) ? charts.columns({
    points, title: req.t('dashboard.chart_30'), fmt: nf, height: 220, width: 720, series: [{ key: 'value', cls: '' }, { key: 'done', cls: 's2' }],
    tipFmt: (p) => `${req.t('dashboard.booked_n', { n: nf(p.value) })} · ${req.t('dashboard.done_n', { n: nf(p.done) })}`, labelMax: false,
  }) : null;

  let money = null;
  if (finance) {
    const [todayRev, monthRev, lastSame, lastFull, byDoctor] = await Promise.all([
      sumOf(lib.whereLocalDates(invBase(ctx), 'i.created_at', today, today, tz)),
      sumOf(lib.whereLocalDates(invBase(ctx), 'i.created_at', `${month}-01`, today, tz)),
      sumOf(lib.whereLocalDates(invBase(ctx), 'i.created_at', lastMonthBounds.from, lastMonthSameDay, tz)),
      sumOf(lib.whereLocalDates(invBase(ctx), 'i.created_at', lastMonthBounds.from, lastMonthBounds.to, tz)),
      lib.whereLocalDates(invBase(ctx), 'i.created_at', `${month}-01`, today, tz).leftJoin('doctors as d', 'd.id', 'i.doctor_id')
        .groupBy('i.doctor_id', 'i.doctor_name', 'd.full_name_en').select('i.doctor_id', 'i.doctor_name', 'd.full_name_en').sum({ v: 'i.amount' }).count({ n: '*' }).orderBy('v', 'desc'),
    ]);
    const change = lastSame.value > 0 ? ((monthRev.value - lastSame.value) / lastSame.value) * 100 : null;
    const money2 = (v) => fmtCore.formatCompact(v, ctx.currency, req.locale);
    money = {
      today: todayRev, month: monthRev, lastSame, lastFull, change,
      byDoctor: byDoctor.length ? charts.bars({ items: byDoctor.slice(0, 8).map((r) => ({ label: (req.locale === 'en' && r.full_name_en) || r.doctor_name || req.t('dashboard.no_doctor'), value: Number(r.v), note: `(${nf(r.n)})` })), fmt: money2 }) : null,
    };
  }

  const b = req.business;
  const setupItems = [
    { key: 'doctors', done: Number(setup[0].n) > 0, href: '/app/doctors/new', perm: 'doctors.manage', icon: 'stethoscope' },
    { key: 'services', done: Number(setup[1].n) > 0, href: '/app/services', perm: 'services.manage', icon: 'clipboard-list' },
    { key: 'portal', done: Boolean(b.slug), href: '/app/settings/portal', perm: 'settings.manage', icon: 'globe' },
    { key: 'logo', done: Boolean(b.logo_mime), href: '/app/settings/appearance', perm: 'settings.manage', icon: 'image' },
  ].filter((i) => perms.has(i.perm));
  const showSetup = setupItems.some((i) => !i.done);

  return res.page('pages/clinic/dashboard/index', {
    title: req.t('nav.dashboard'), greeting: req.t(greetingKey(tz), { name: String(ctx.userName || '').split(/\s+/)[0] }),
    kpi, schedule, pendingOnline, pendingCount: Number(pendingCount.n) || 0, lowStock: lowStock ? Number(lowStock.n) : null,
    apptChart, money, finance, setupItems, showSetup, statusTone: lib.STATUS_TONE,
    nowTime: scheduling.minutesToTime(scheduling.clinicNow(tz).minutes), localTime: (d) => lib.localTime(d, tz),
    ...PAGE,
  });
}));

// ---------------------------------------------------------------- my day
router.get('/my-day', wrap(async (req, res) => {
  const { ctx } = req;
  if (!ctx.doctorId) {
    if (ctx.permissions.has('dashboard.view')) return res.redirect('/app');
    throw E.notFound('Page');
  }
  if (!['appointments.view', 'clinical.view'].some((p) => ctx.permissions.has(p))) throw E.forbidden('appointments.view');
  const doctor = await knex('doctors').where({ id: ctx.doctorId, business_id: ctx.businessId }).first();
  if (!doctor) throw E.notFound('Doctor');
  const today = ctx.today;
  const date = lib.isIso(req.query.date) ? req.query.date : today;
  const tz = ctx.timezone;
  const now = scheduling.clinicNow(tz);
  const [rows, daysOff, offToday, weekRows] = await Promise.all([
    knex('appointments as a').leftJoin('services as s', 's.id', 'a.service_id')
      .where({ 'a.business_id': ctx.businessId, 'a.doctor_id': doctor.id, 'a.appointment_date': date })
      .orderBy('a.appointment_time')
      .select('a.*', 's.name as service_name', 's.name_en as service_name_en', knex.raw('COALESCE(a.duration_minutes, s.duration_minutes, ?) as length', [doctor.slot_duration_minutes || 30])),
    knex('doctor_days_off').where({ business_id: ctx.businessId, doctor_id: doctor.id }).where('off_date', '>=', today).orderBy('off_date').limit(6),
    knex('doctor_days_off').where({ business_id: ctx.businessId, doctor_id: doctor.id, off_date: date }).first(),
    knex('appointments').where({ business_id: ctx.businessId, doctor_id: doctor.id }).whereBetween('appointment_date', [lib.addDays(date, 1), lib.addDays(date, 7)])
      .whereNot('appointment_type', 'blocked').whereIn('status', ACTIVE).groupBy('appointment_date').select('appointment_date as d').count({ n: '*' }),
  ]);
  const isToday = date === today;
  const items = rows.map((a) => {
    const arrived = a.arrived_at ? lib.localTime(a.arrived_at, tz) : null;
    let waitedMin = null;
    if (isToday && a.checked_in && !a.with_doctor && ACTIVE.includes(a.status) && a.arrived_at) waitedMin = Math.max(0, Math.round((Date.now() - new Date(a.arrived_at).getTime()) / 60000));
    const endMin = scheduling.timeToMinutes(a.appointment_time) + Number(a.length || 30);
    return {
      ...a, arrivedTime: arrived ? arrived.time : null, waitedMin, end: scheduling.minutesToTime(endMin % (24 * 60)),
      state: a.appointment_type === 'blocked' ? 'blocked' : (a.with_doctor && ACTIVE.includes(a.status) ? 'with' : (a.checked_in && ACTIVE.includes(a.status) ? 'waiting' : a.status)),
      past: isToday ? endMin <= now.minutes : date < today,
    };
  });
  const patients = items.filter((a) => a.state !== 'blocked');
  const counts = {
    total: patients.filter((a) => a.status !== 'cancelled').length,
    completed: patients.filter((a) => a.status === 'completed').length,
    waiting: patients.filter((a) => a.state === 'waiting').length,
    remaining: patients.filter((a) => a.state === 'pending' || a.state === 'confirmed').length,
    noShows: patients.filter((a) => a.status === 'no_show').length,
  };
  const withMe = patients.find((a) => a.state === 'with') || null;
  const waitingQueue = patients.filter((a) => a.state === 'waiting').sort((x, y) => String(x.arrived_at || '').localeCompare(String(y.arrived_at || '')));
  let next = waitingQueue[0] || null;
  if (!next) {
    const nowT = scheduling.minutesToTime(now.minutes);
    next = patients.find((a) => ACTIVE.includes(a.status) && !a.checked_in && (!isToday || a.appointment_time >= nowT))
      || (isToday ? patients.find((a) => ACTIVE.includes(a.status) && !a.checked_in) : null) || null;
  }
  const wh = typeof doctor.working_hours === 'string' ? JSON.parse(doctor.working_hours || 'null') : doctor.working_hours;
  const day = scheduling.normalizeDayConfig((wh || {})[scheduling.dayKeyOf(date)]);

  let revenue = null;
  if (ctx.permissions.has('finance.view')) {
    revenue = await sumOf(lib.whereLocalDates(knex('invoices as i').where({ 'i.business_id': ctx.businessId, 'i.doctor_id': doctor.id }), 'i.created_at', date, date, tz));
  }
  const week = [];
  const wk = Object.fromEntries(weekRows.map((r) => [r.d, Number(r.n)]));
  for (let i = 1; i <= 7; i += 1) { const d = lib.addDays(date, i); week.push({ date: d, n: wk[d] || 0 }); }

  return res.page('pages/clinic/dashboard/my-day', {
    title: req.t('my_day.title'), doctor, date, isToday, prev: lib.addDays(date, -1), next: lib.addDays(date, 1), items, counts, withMe, nextPatient: next,
    waitingQueue, daysOff, offToday, day, revenue, week, statusTone: lib.STATUS_TONE, autoRefresh: isToday, ...PAGE,
  });
}));

module.exports = router;
