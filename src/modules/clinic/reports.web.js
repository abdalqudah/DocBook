// Clinic reports for a month or a custom range: appointments by status / doctor / service / source,
// new vs returning patients, revenue by payment method, discounts, and (finance.view) expenses, payroll and net.
const express = require('express');
const knex = require('../../db/knex');
const charts = require('../../core/charts');
const exporter = require('../../core/exporter');
const fmtCore = require('../../core/format');
const { wrap } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const lib = require('./records.lib');
const payParts = require('./payment-parts');
const branchesSvc = require('./branches.service');

const router = express.Router();
router.use(can('reports.view'));

const STATUSES = ['pending', 'confirmed', 'completed', 'no_show', 'cancelled'];
const SECTIONS = ['status', 'doctors', 'services', 'sources', 'patients', 'methods', 'daily', 'finance'];

const apptBase = (ctx, r) => {
  const q = knex('appointments as a').where('a.business_id', ctx.businessId).whereNot('a.appointment_type', 'blocked').whereBetween('a.appointment_date', [r.from, r.to]);
  if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId);
  return branchesSvc.scope(q, ctx); // the branch chosen in the account menu (or the member's own)
};
const invBase = (ctx, r) => {
  const q = lib.whereLocalDates(knex('invoices as i').where('i.business_id', ctx.businessId), 'i.created_at', r.from, r.to, ctx.timezone);
  if (ctx.ownDoctorId) q.where('i.doctor_id', ctx.ownDoctorId);
  // a branch: receipts of its visits (a sale without a visit belongs to the main branch)
  const v = String(ctx.workBranch || '');
  if (v) {
    const inBranch = knex('appointments').select('id').where('business_id', ctx.businessId).modify((x) => (v === 'main' ? x.whereNull('branch_id') : x.where('branch_id', Number(v))));
    if (v === 'main') q.where((w) => w.whereNull('i.appointment_id').orWhereIn('i.appointment_id', inBranch)); else q.whereIn('i.appointment_id', inBranch);
  }
  return q;
};
const num = (v) => Number(v) || 0;

async function build(req, range) {
  const { ctx } = req;
  const en = req.locale === 'en';
  const finance = ctx.permissions.has('finance.view');
  const [statusRows, docAppts, docRev, doctors, svcAppts, svcRev, sourceRows, methodRows, discountRow, patientRows, dailyAppts, dailyRev, registered] = await Promise.all([
    apptBase(ctx, range).groupBy('a.status').select('a.status').count({ n: '*' }),
    apptBase(ctx, range).whereNot('a.status', 'cancelled').groupBy('a.doctor_id').select('a.doctor_id').count({ n: '*' })
      .select(knex.raw("SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as done"), knex.raw("SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) as no_show")),
    invBase(ctx, range).groupBy('i.doctor_id').select('i.doctor_id', knex.raw('MAX(i.doctor_name) as doctor_name')).sum({ v: 'i.amount' }).count({ n: '*' }),
    knex('doctors').where({ business_id: ctx.businessId }).select('id', 'full_name', 'full_name_en', 'color'),
    apptBase(ctx, range).leftJoin('services as s', 's.id', 'a.service_id').whereNot('a.status', 'cancelled').groupBy('a.service_id', 's.name', 's.name_en')
      .select('a.service_id', 's.name', 's.name_en').count({ n: '*' }).select(knex.raw("SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as done")),
    invBase(ctx, range).leftJoin('appointments as ia', 'ia.id', 'i.appointment_id').groupBy('ia.service_id', 'i.service_name')
      .select('ia.service_id', 'i.service_name').sum({ v: 'i.amount' }).count({ n: '*' }),
    apptBase(ctx, range).groupBy('a.source').select('a.source').count({ n: '*' })
      .select(knex.raw("SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as done"), knex.raw("SUM(CASE WHEN a.status IN ('cancelled','no_show') THEN 1 ELSE 0 END) as lost")),
    // Revenue by payment method from the payment parts (cash + card counts under both; no "mixed" bucket).
    payParts.totalsByMethod(invBase(ctx, range), 'i.id', ctx.businessId),
    invBase(ctx, range).first(knex.raw('COALESCE(SUM(i.discount_amount),0) as total'), knex.raw('SUM(CASE WHEN i.discount_amount > 0 THEN 1 ELSE 0 END) as n'),
      knex.raw('COALESCE(AVG(CASE WHEN i.discount_percent > 0 THEN i.discount_percent END),0) as avg_pct'), knex.raw('COALESCE(SUM(i.amount),0) as revenue'), knex.raw('COUNT(*) as invoices')),
    // First-ever visit of each patient seen in the range (new = first visit falls inside the range).
    knex.select('x.patient_id', 'x.first').from(
      knex('appointments').where({ business_id: ctx.businessId }).whereNotNull('patient_id').whereNot('appointment_type', 'blocked').whereNot('status', 'cancelled')
        .groupBy('patient_id').select('patient_id', knex.raw('MIN(appointment_date) as first')).as('x'),
    ).whereIn('x.patient_id', apptBase(ctx, range).whereNot('a.status', 'cancelled').whereNotNull('a.patient_id').distinct('a.patient_id')),
    apptBase(ctx, range).whereNot('a.status', 'cancelled').groupBy('a.appointment_date').select('a.appointment_date as d').count({ n: '*' }),
    invBase(ctx, range).groupBy('d').select(knex.raw(`${lib.localDateSql('i.created_at', ctx.timezone).toString()} as d`)).sum({ v: 'i.amount' }),
    lib.whereLocalDates(require('./branches.service').scopePatients(knex('patients').where({ business_id: ctx.businessId }), ctx, 'patients.id'), 'created_at', range.from, range.to, ctx.timezone).count({ n: '*' }).first(), // eslint-disable-line global-require
  ]);

  // ---- status
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  statusRows.forEach((r) => { byStatus[r.status] = num(r.n); });
  const total = Object.values(byStatus).reduce((s, v) => s + v, 0);
  const status = {
    rows: STATUSES.map((s) => ({ key: s, n: byStatus[s], share: total ? (byStatus[s] * 100) / total : 0 })), total,
    noShowRate: total ? (byStatus.no_show * 100) / total : null, cancelRate: total ? (byStatus.cancelled * 100) / total : null,
    completionRate: total ? (byStatus.completed * 100) / total : null,
  };

  // ---- doctors
  const docName = Object.fromEntries(doctors.map((d) => [d.id, (en && d.full_name_en) || d.full_name]));
  const docColor = Object.fromEntries(doctors.map((d) => [d.id, d.color]));
  const dmap = new Map();
  const drow = (id, name) => { const k = id || 0; if (!dmap.has(k)) dmap.set(k, { id, name: docName[id] || name || req.t('dashboard.no_doctor'), color: docColor[id], appts: 0, done: 0, noShow: 0, revenue: 0, invoices: 0 }); return dmap.get(k); };
  docAppts.forEach((r) => { const d = drow(r.doctor_id); d.appts = num(r.n); d.done = num(r.done); d.noShow = num(r.no_show); });
  docRev.forEach((r) => { const d = drow(r.doctor_id, r.doctor_name); d.revenue = num(r.v); d.invoices = num(r.n); });
  const byDoctor = [...dmap.values()].map((d) => ({ ...d, avg: d.invoices ? d.revenue / d.invoices : null })).sort((a, b) => b.revenue - a.revenue || b.appts - a.appts);

  // ---- services (bookings by service id; revenue by the service on the invoiced visit, else the invoice's snapshot name)
  const smap = new Map();
  const srow = (key, name) => { if (!smap.has(key)) smap.set(key, { name: name || req.t('reports.no_service'), n: 0, done: 0, revenue: 0, invoices: 0 }); return smap.get(key); };
  svcAppts.forEach((r) => { const s = srow(r.service_id ? `id:${r.service_id}` : 'none', (en && r.name_en) || r.name); s.n = num(r.n); s.done = num(r.done); });
  svcRev.forEach((r) => { const s = srow(r.service_id ? `id:${r.service_id}` : (r.service_name ? `name:${r.service_name}` : 'none'), r.service_name); s.revenue += num(r.v); s.invoices += num(r.n); });
  const byService = [...smap.values()].sort((a, b) => b.revenue - a.revenue || b.n - a.n);

  // ---- sources
  const bySource = ['staff', 'website'].map((k) => { const r = sourceRows.find((x) => x.source === k) || {}; return { key: k, n: num(r.n), done: num(r.done), lost: num(r.lost) }; });

  // ---- patients
  const newCount = patientRows.filter((p) => p.first >= range.from).length;
  const patients = { seen: patientRows.length, new: newCount, returning: patientRows.length - newCount, registered: num(registered.n) };

  // ---- money
  const methods = methodRows.rows.map((r) => ({ key: r.method, n: r.invoices, v: r.amount }));
  const revenue = num(discountRow.revenue);
  const discounts = { total: num(discountRow.total), n: num(discountRow.n), avgPct: num(discountRow.avg_pct), invoices: num(discountRow.invoices), gross: revenue + num(discountRow.total) };

  let fin = null;
  // a branch: its own expenses, its doctors' pay and its employees' salaries
  if (finance) {
    const [exp, pay] = await Promise.all([
      branchesSvc.scope(knex('expenses').where({ business_id: ctx.businessId }), ctx, 'branch_id').whereBetween('date', [range.from, range.to]).first(knex.raw('COALESCE(SUM(amount),0) as v'), knex.raw('COUNT(*) as n')),
      // Salaries as in the profit & loss: doctors' net + advances taken back, plus paid staff salaries.
      knex('payroll_payments').where({ business_id: ctx.businessId }).modify((q) => { if (ctx.workBranch) q.whereIn('doctor_id', branchesSvc.scope(knex('doctors').where({ business_id: ctx.businessId }), ctx, 'branch_id').select('id')); }).whereBetween('period', [range.from.slice(0, 7), range.to.slice(0, 7)]).first(knex.raw('COALESCE(SUM(net_pay + advances),0) as v'), knex.raw('COUNT(*) as n')),
    ]);
    const staffPaid = await require('../finance/staff.service').paidByMonth(ctx.businessId, range.from.slice(0, 7), range.to.slice(0, 7), ctx); // eslint-disable-line global-require
    const expenses = num(exp.v); const payroll = Math.round((num(pay.v) + Object.values(staffPaid).reduce((a, v) => a + num(v), 0)) * 1000) / 1000;
    fin = { revenue, expenses, expenseCount: num(exp.n), payroll, payrollCount: num(pay.n), net: revenue - expenses - payroll, margin: revenue ? ((revenue - expenses - payroll) * 100) / revenue : null };
  }

  // ---- daily series (months when the range is long)
  const days = lib.daysBetween(range.from, range.to) + 1;
  const byMonth = days > 92;
  const series = new Map();
  const keyOf = (d) => (byMonth ? d.slice(0, 7) : d);
  if (byMonth) { for (let m = range.from.slice(0, 7); m <= range.to.slice(0, 7); m = lib.addMonths(m, 1)) series.set(m, { appts: 0, revenue: 0 }); } else { for (let i = 0; i < days; i += 1) series.set(lib.addDays(range.from, i), { appts: 0, revenue: 0 }); }
  dailyAppts.forEach((r) => { const s = series.get(keyOf(r.d)); if (s) s.appts += num(r.n); });
  dailyRev.forEach((r) => { const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10); const s = series.get(keyOf(d)); if (s) s.revenue += num(r.v); });
  const daily = [...series.entries()].map(([k, v]) => ({ key: k, ...v }));

  return { status, byDoctor, byService, bySource, patients, methods, discounts, revenue, fin, daily, byMonth };
}

function sectionTable(req, data, section) {
  const t = req.t;
  const pct = (v) => (v === null || v === undefined ? '' : Math.round(v * 10) / 10);
  switch (section) {
    case 'status': return { header: [t('common.status'), t('reports.count'), t('reports.share_pct')], rows: data.status.rows.map((r) => [t(`dashboard.statuses.${r.key}`), r.n, pct(r.share)]).concat([[t('common.total'), data.status.total, 100]]) };
    case 'doctors': return { header: [t('common.doctor'), t('reports.appointments'), t('reports.completed'), t('reports.no_shows'), t('reports.invoices'), t('reports.revenue'), t('reports.avg_ticket')], rows: data.byDoctor.map((d) => [d.name, d.appts, d.done, d.noShow, d.invoices, d.revenue, d.avg === null ? '' : Math.round(d.avg * 100) / 100]) };
    case 'services': return { header: [t('common.service'), t('reports.appointments'), t('reports.completed'), t('reports.invoices'), t('reports.revenue')], rows: data.byService.map((s) => [s.name, s.n, s.done, s.invoices, s.revenue]) };
    case 'sources': return { header: [t('reports.source'), t('reports.appointments'), t('reports.completed'), t('reports.lost')], rows: data.bySource.map((s) => [t(`dashboard.sources.${s.key}`), s.n, s.done, s.lost]) };
    case 'patients': return { header: [t('reports.metric'), t('reports.count')], rows: [[t('reports.patients_seen'), data.patients.seen], [t('reports.new_patients'), data.patients.new], [t('reports.returning_patients'), data.patients.returning], [t('reports.registered'), data.patients.registered]] };
    case 'methods': return { header: [t('billing.method'), t('reports.invoices'), t('reports.revenue')], rows: data.methods.map((m) => [t(`invoicex.m.${m.key}`), m.n, m.v]).concat([[t('reports.discounts_total'), data.discounts.n, data.discounts.total]]) };
    case 'daily': return { header: [data.byMonth ? t('common.month') : t('common.date'), t('reports.appointments'), t('reports.revenue')], rows: data.daily.map((d) => [d.key, d.appts, d.revenue]) };
    case 'finance': return data.fin ? { header: [t('reports.metric'), t('common.amount')], rows: [[t('reports.revenue'), data.fin.revenue], [t('reports.expenses'), data.fin.expenses], [t('reports.payroll'), data.fin.payroll], [t('reports.net'), data.fin.net]] } : null;
    default: return null;
  }
}

router.get('/', wrap(async (req, res) => {
  const range = lib.resolveRange(req.query, req.ctx.today);
  const data = await build(req, range);

  if (req.query.export) {
    const section = SECTIONS.includes(req.query.export) ? req.query.export : 'status';
    const table = sectionTable(req, data, section);
    if (!table) return res.redirect('/app/reports');
    return exporter.send(req, res, { name: `${req.t('reports.title')} ${req.t(`reports.sec.${section}`)} ${range.from}_${range.to}`, ...table });
  }

  const L = (d, o) => fmtCore.formatDate(d, req.locale, o);
  const nf = (v) => fmtCore.formatNumber(v, req.locale, 0);
  const mf = (v) => fmtCore.formatCompact(v, req.ctx.currency, req.locale);
  const points = data.daily.map((d) => (data.byMonth
    ? { label: fmtCore.formatMonth(d.key, req.locale), short: L(`${d.key}-01`, { month: 'short' }), appts: d.appts, revenue: d.revenue }
    : { label: L(d.key, { weekday: 'short', day: 'numeric', month: 'short' }), short: L(d.key, { day: 'numeric', month: 'numeric' }), appts: d.appts, revenue: d.revenue }));
  const hasAppts = data.status.total > 0;
  const chartsHtml = {
    appts: points.some((p) => p.appts) ? charts.columns({ points, title: req.t('reports.chart_appts'), fmt: nf, series: [{ key: 'appts', cls: '' }], height: 220, width: 720, tipFmt: (p) => req.t('dashboard.booked_n', { n: nf(p.appts) }) }) : null,
    revenue: points.some((p) => p.revenue) ? charts.line({ points, title: req.t('reports.chart_revenue'), fmt: mf, series: [{ key: 'revenue', cls: '' }], height: 220, width: 720 }) : null,
    status: hasAppts ? charts.donut({ items: data.status.rows.map((r) => ({ label: req.t(`dashboard.statuses.${r.key}`), value: r.n })), fmt: nf, title: req.t('reports.sec.status'), otherLabel: req.t('reports.other') }) : null,
    doctors: data.byDoctor.some((d) => d.revenue) ? charts.bars({ items: data.byDoctor.slice(0, 10).map((d) => ({ label: d.name, value: d.revenue })), fmt: mf }) : null,
    methods: data.methods.length ? charts.donut({ items: data.methods.map((m) => ({ label: req.t(`invoicex.m.${m.key}`), value: m.v })), fmt: mf, title: req.t('reports.sec.methods'), otherLabel: req.t('reports.other') }) : null,
    services: data.byService.some((s) => s.n) ? charts.bars({ items: data.byService.slice(0, 8).map((s) => ({ label: s.name, value: s.n, cls: 's2' })), fmt: nf }) : null,
  };
  const months = [];
  for (let i = 0; i < 24; i += 1) months.push(lib.addMonths(req.ctx.today.slice(0, 7), -i));
  return res.page('pages/clinic/reports/index', {
    title: req.t('reports.title'), range, data, charts: chartsHtml, months, printable: true, pageScripts: ['/js/records.js'], pageStyles: ['/css/records.css'],
  });
}));

module.exports = router;
