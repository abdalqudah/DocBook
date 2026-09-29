// Doctor payroll: monthly sheet, per-doctor breakdown, commission rules, adjustments (with approval) and payslips.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const exporter = require('../../core/exporter');
const svc = require('./payroll.service');

const router = express.Router();
router.use(can('payroll.view'));

const METHODS = ['bank_transfer', 'cash', 'card', 'digital_wallet'];
const isPeriod = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));
const periodOf = (req) => [req.query.period, req.body && req.body.period].find(isPeriod) || req.ctx.today.slice(0, 7);
function shift(period, n) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const nav = (period) => ({ period, prevPeriod: shift(period, -1), nextPeriod: shift(period, 1) });
const errText = (req, err) => { const k = `errors.${err.code}`; const tr = req.t(k); return tr !== k ? tr : err.message; };

/** Runs a POST action; expected business errors become an error toast instead of an error page. */
const attempt = (fn) => wrap(async (req, res) => {
  const to = req.body._return && String(req.body._return).startsWith('/app/payroll') ? req.body._return : '/app/payroll';
  try {
    const msg = await fn(req, res);
    if (msg) flash(req, 'success', msg);
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500 || err.status === 403) throw err;
    flash(req, 'error', err.code === 'VALIDATION_FAILED' ? req.t('errors.VALIDATION_FAILED') : errText(req, err));
  }
  res.redirect(to);
});

// payroll.service.calculate() spreads the payroll figures over its result, so `commission` there is the total (a number)
// and the per-invoice detail is lost; the detail is re-attached here as `commission` and the total kept on `commissionTotal`.
async function calcFull(ctx, doctorId, period) {
  const c = await svc.calculate(ctx, doctorId, period);
  const detail = await svc.commission(ctx, doctorId, c.range.from, c.range.to);
  return { ...c, commissionTotal: detail.totalCommission, commission: detail };
}
async function sheet(ctx, period) {
  const docs = await knex('doctors').where({ business_id: ctx.businessId }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }]).select('id');
  const rows = [];
  for (const d of docs) rows.push(await calcFull(ctx, d.id, period)); // eslint-disable-line no-await-in-loop
  return rows;
}
const sumRows = (rows) => rows.reduce((t, r) => ({ base: t.base + r.baseSalary, commission: t.commission + r.commissionTotal, bonuses: t.bonuses + r.bonuses,
  deductions: t.deductions + r.deductions + r.advances, net: t.net + r.netPayroll, revenue: t.revenue + r.commission.totalRevenue, visits: t.visits + r.commission.visitCount }),
{ base: 0, commission: 0, bonuses: 0, deductions: 0, net: 0, revenue: 0, visits: 0 });

async function doctorsMap(ctx) {
  const rows = await knex('doctors').where({ business_id: ctx.businessId }).select('id', 'full_name', 'full_name_en', 'specialization', 'specialization_en', 'color', 'is_active', 'base_salary');
  return Object.fromEntries(rows.map((d) => [d.id, d]));
}
async function rulesMap(ctx) {
  const rows = await knex('commission_rules').where({ business_id: ctx.businessId }).select('doctor_id', 'basis', 'rate');
  return Object.fromEntries(rows.map((r) => [r.doctor_id, { basis: r.basis, rate: Number(r.rate) }]));
}
const pendingFor = (ctx, period, doctorId) => knex('payroll_adjustments as a').join('doctors as d', 'd.id', 'a.doctor_id').leftJoin('users as u', 'u.id', 'a.created_by')
  .where({ 'a.business_id': ctx.businessId, 'a.period': period, 'a.approval_status': 'pending' }).modify((q) => { if (doctorId) q.where('a.doctor_id', doctorId); })
  .orderBy('a.created_at').select('a.*', 'd.full_name', 'd.full_name_en', 'u.name as created_by_name');

async function buildSheet(ctx, period) {
  const [rows, docs, rules, pending] = await Promise.all([sheet(ctx, period), doctorsMap(ctx), rulesMap(ctx), pendingFor(ctx, period)]);
  // Inactive doctors are listed only when they have something in this month.
  const list = rows.map((r) => ({ ...r, info: docs[r.doctor.id], rule: rules[r.doctor.id] || null, pending: r.adjustments.filter((a) => a.approvalStatus === 'pending').length }))
    .filter((r) => r.info.is_active || r.commission.visitCount || r.adjustments.length || r.payment);
  return { rows: list, totals: sumRows(list), pending };
}

router.get('/', wrap(async (req, res) => {
  const period = periodOf(req);
  const { rows, totals, pending } = await buildSheet(req.ctx, period);
  const paidCount = rows.filter((r) => r.payment).length;
  const netPaid = rows.filter((r) => r.payment).reduce((s, r) => s + Number(r.payment.net_pay), 0);
  res.page('pages/clinic/payroll/index', {
    title: req.t('payroll.title'), ...nav(period), rows, totals, pending, paidCount, netPaid,
    pageScripts: ['/js/ops.js'], pageStyles: ['/css/ops.css'],
  });
}));

router.get('/export', can('data.export'), wrap(async (req, res) => {
  const period = periodOf(req);
  const { rows } = await buildSheet(req.ctx, period);
  const t = req.t;
  const L = (d) => (req.locale === 'en' && d.full_name_en ? d.full_name_en : d.full_name);
  exporter.send(req, res, {
    name: `${t('payroll.title')} ${period}`,
    header: [t('common.doctor'), t('payroll.revenue'), t('payroll.visits'), t('payroll.patients'), t('payroll.basis'), t('payroll.commission'), t('payroll.base_salary'), t('payroll.bonuses'), t('payroll.deductions'), t('payroll.advances'), t('payroll.net_pay'), t('common.status')],
    rows: rows.map((r) => [L(r.info), r.commission.totalRevenue, r.commission.visitCount, r.commission.uniquePatientCount, r.rule ? t(`commission.basis.${r.rule.basis}`) : t('payroll.no_rule'),
      r.commission.totalCommission, r.baseSalary, r.bonuses, r.deductions, r.advances, r.netPayroll, r.payment ? t('payroll.status.paid') : t('payroll.status.unpaid')]),
  });
}));

router.post('/adjustments/:adj(\\d+)/review', can('payroll.approve'), attempt(async (req) => {
  const decision = req.body.decision === 'approved' ? 'approved' : 'rejected';
  await svc.reviewAdjustment(req.ctx, Number(req.params.adj), decision);
  return req.t(decision === 'approved' ? 'payroll.adj_approved' : 'payroll.adj_rejected');
}));

// ---------------------------------------------------------------- one doctor
async function renderDoctor(req, res, extra = {}) {
  const period = periodOf(req);
  const id = Number(req.params.id);
  const calc = await calcFull(req.ctx, id, period);
  const [info, rule, services] = await Promise.all([
    knex('doctors').where({ id, business_id: req.ctx.businessId }).first(),
    svc.rule(req.ctx, id),
    knex('services').where({ business_id: req.ctx.businessId }).orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('name', 'name_en', 'doctor_id', 'is_active'),
  ]);
  // Overrides match the service name stored on each invoice; keep names used by existing overrides even if renamed since.
  const names = [...new Set(services.map((s) => s.name))];
  (rule ? rule.serviceOverrides : []).forEach((o) => { if (!names.includes(o.serviceName)) names.push(o.serviceName); });
  const serviceOptions = names.map((n) => { const s = services.find((x) => x.name === n); return { value: n, label: s && req.locale === 'en' && s.name_en ? `${s.name_en} · ${n}` : n }; });
  res.page('pages/clinic/payroll/doctor', {
    title: `${req.t('payroll.title')} · ${info.full_name}`, ...nav(period), calc, info, rule, serviceOptions, methods: METHODS,
    pageScripts: ['/js/ops.js'], pageStyles: ['/css/ops.css'], ...extra,
  });
}
router.get('/doctors/:id(\\d+)', wrap((req, res) => renderDoctor(req, res)));

const back = (req) => `/app/payroll/doctors/${req.params.id}?period=${periodOf(req)}`;
router.post('/doctors/:id(\\d+)/rule', can('payroll.manage'), form(async (req, res) => {
  await svc.saveRule(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('payroll.rule_saved'));
  res.redirect(`${back(req)}#rule`);
}, (req, res, extra) => renderDoctor(req, res, { ...extra, ruleForm: true })));

router.post('/doctors/:id(\\d+)/adjustments', can('payroll.manage'), form(async (req, res) => {
  await svc.addAdjustment(req.ctx, Number(req.params.id), { ...req.body, period: periodOf(req) });
  flash(req, 'success', req.t('payroll.adj_added'));
  res.redirect(`${back(req)}#adjustments`);
}, (req, res, extra) => renderDoctor(req, res, { ...extra, adjForm: true })));

router.post('/doctors/:id(\\d+)/pay', can('payroll.approve'), attempt(async (req) => {
  const method = METHODS.includes(req.body.method) ? req.body.method : null;
  await svc.markPaid(req.ctx, Number(req.params.id), periodOf(req), { method, reference: String(req.body.reference || '').trim().slice(0, 100) || null });
  return req.t('payroll.marked_paid');
}));
router.post('/doctors/:id(\\d+)/unpay', can('payroll.approve'), attempt(async (req) => {
  await svc.undoPaid(req.ctx, Number(req.params.id), periodOf(req));
  return req.t('payroll.payment_undone');
}));

router.get('/doctors/:id(\\d+)/payslip', wrap(async (req, res) => {
  const period = periodOf(req);
  const id = Number(req.params.id);
  const calc = await calcFull(req.ctx, id, period);
  const info = await knex('doctors').where({ id, business_id: req.ctx.businessId }).first();
  const p = calc.payment;
  const figures = p ? { base: Number(p.base_salary), commission: Number(p.commission), bonuses: Number(p.bonuses), deductions: Number(p.deductions), advances: Number(p.advances), net: Number(p.net_pay) }
    : { base: calc.baseSalary, commission: calc.commissionTotal, bonuses: calc.bonuses, deductions: calc.deductions, advances: calc.advances, net: calc.netPayroll };
  const rule = await svc.rule(req.ctx, id);
  res.page('pages/clinic/payroll/payslip', {
    title: `${req.t('payroll.payslip')} · ${info.full_name} · ${period}`, ...nav(period), calc, info, rule, figures, draft: !p, printable: true,
    pageStyles: ['/css/ops.css'],
  });
}));

module.exports = router;
