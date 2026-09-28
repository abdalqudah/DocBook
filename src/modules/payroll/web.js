const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const exporter = require('../../core/exporter');
const fmt = require('../../core/format');
const knex = require('../../db/knex');
const engine = require('../finance/engine');
const fin = require('../finance/finance.data');
const svc = require('./payroll.service');

const router = express.Router();
router.use(can('payroll.view'));

const monthOf = (req) => fin.monthFromQuery(req.query.month || req.body?.month);

// ---- Monthly payroll run
router.get('/', wrap(async (req, res) => {
  const month = monthOf(req) || fmt.currentMonth();
  const { rows, totals } = await svc.sheet(req.ctx, month);
  const d = await fin.load(req.ctx.businessId);
  res.page('pages/payroll/index', { title: req.t('nav.payroll'), month, periodOptions: fin.periodOptions(d), rows, totals, employeesCount: d.employees.length, printable: true });
}));
router.post('/pay', can('payroll.manage'), wrap(async (req, res) => {
  const month = monthOf(req);
  if (req.body.employee_id) {
    await svc.markPaid(req.ctx, Number(req.body.employee_id), month, { method: req.body.method, reference: req.body.reference });
    flash(req, 'success', req.t('payroll.marked_paid'));
  } else {
    const n = await svc.markAllPaid(req.ctx, month, { method: req.body.method, reference: req.body.reference });
    flash(req, 'success', req.t('payroll.marked_all', { n }));
  }
  res.redirect(`/app/payroll?month=${month}`);
}));
router.post('/unpay', can('payroll.manage'), wrap(async (req, res) => {
  const month = monthOf(req);
  await svc.unmarkPaid(req.ctx, Number(req.body.employee_id), month);
  flash(req, 'success', req.t('payroll.unmarked'));
  res.redirect(`/app/payroll?month=${month}`);
}));
router.get('/export', can('data.export'), wrap(async (req, res) => {
  const month = monthOf(req) || fmt.currentMonth();
  const { rows } = await svc.sheet(req.ctx, month);
  const t = req.t;
  exporter.send(req, res, {
    name: `${t('nav.payroll')} ${month}`,
    header: [t('payroll.employee'), t('payroll.role'), t('payroll.base_salary'), t('payroll.bonus'), t('payroll.deductions'), t('payroll.commission'), t('payroll.net_pay'), t('common.status'), t('payroll.bank_account')],
    rows: rows.map((r) => [r.name, r.role || '', r.baseSalary, r.bonus, r.deductions, r.commission, r.net, r.paid ? t('payroll.paid') : t('payroll.unpaid'), r.bankAccount || '']),
  });
}));

// ---- Employee directory
router.get('/employees', wrap(async (req, res) => {
  const { rows, meta } = await svc.employees.list(req.ctx, req.query, { perPage: 50 });
  const month = fmt.currentMonth();
  const d = await fin.load(req.ctx.businessId);
  const commission = {};
  d.orders.filter((o) => engine.toMonthKey(o.date) === month && o.employeeId).forEach((o) => { commission[o.employeeId] = (commission[o.employeeId] || 0) + o.commissionEarned; });
  res.page('pages/payroll/employees', { title: req.t('payroll.employees'), rows, meta, commission, month, statuses: svc.STATUSES, filtered: Boolean(req.query.q || (req.query.status && req.query.status !== 'all')) });
}));
router.get('/employees/export', can('data.export'), wrap(async (req, res) => {
  const { rows } = await svc.employees.list(req.ctx, req.query, { all: true });
  const t = req.t; const lbl = res.locals.label;
  exporter.send(req, res, {
    name: t('payroll.employees'),
    header: [t('common.name'), t('payroll.role'), t('common.phone'), t('common.email'), t('payroll.base_salary'), t('payroll.commission_type'), t('payroll.commission_rate'), t('payroll.bonus'), t('payroll.deductions'), t('payroll.monthly_net'), t('payroll.hire_date'), t('common.status'), t('payroll.bank_account')],
    rows: rows.map((r) => [r.name, r.role || '', r.phone || '', r.email || '', Number(r.base_salary), lbl('payroll.types', r.commission_type), Number(r.commission_rate), Number(r.bonus), Number(r.deductions), Number(r.base_salary) + Number(r.bonus) - Number(r.deductions), r.hire_date || '', lbl('payroll.statuses', r.status), r.bank_account || '']),
  });
}));

const renderForm = async (req, res, extra = {}) => {
  const employee = req.params.id ? await svc.employees.get(req.ctx, Number(req.params.id)) : null;
  res.page('pages/payroll/form', { title: employee ? req.t('payroll.edit_employee') : req.t('payroll.add_employee'), employee, regions: await svc.regions(req.ctx), statuses: svc.STATUSES, types: svc.COMMISSION_TYPES, ...extra });
};
router.get('/employees/new', can('payroll.manage'), wrap((req, res) => renderForm(req, res)));
router.post('/employees/new', can('payroll.manage'), form(async (req, res) => {
  const id = await svc.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('payroll.employee_saved'));
  res.redirect(`/app/payroll/employees/${id}`);
}, renderForm));
router.get('/employees/:id(\\d+)/edit', can('payroll.manage'), wrap((req, res) => renderForm(req, res)));
router.post('/employees/:id(\\d+)/edit', can('payroll.manage'), form(async (req, res) => {
  await svc.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(`/app/payroll/employees/${req.params.id}`);
}, renderForm));
router.post('/employees/:id(\\d+)/delete', can('payroll.manage'), wrap(async (req, res) => {
  await svc.employees.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('payroll.employee_deleted'));
  res.redirect('/app/payroll/employees');
}));

router.get('/employees/:id(\\d+)', wrap(async (req, res) => {
  const employee = await svc.employees.get(req.ctx, Number(req.params.id));
  const d = await fin.load(req.ctx.businessId);
  const e = d.employees.find((x) => x.id === employee.id);
  const orders = d.orders.filter((o) => String(o.employeeId) === String(employee.id));
  const byMonth = {};
  orders.forEach((o) => { const k = engine.toMonthKey(o.date); byMonth[k] = byMonth[k] || { orders: 0, sales: 0, commission: 0 }; byMonth[k].orders += 1; byMonth[k].sales += o.totalAmount; byMonth[k].commission += o.commissionEarned; });
  res.page('pages/payroll/show', {
    title: employee.name, employee: e, payments: await svc.payments(req.ctx, employee.id), byMonth: Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12),
    recentOrders: orders.slice(0, 8), thisMonth: fmt.currentMonth(),
  });
}));

router.get('/employees/:id(\\d+)/payslip/:month(\\d{4}-\\d{2})', wrap(async (req, res) => {
  const employee = await svc.employees.get(req.ctx, Number(req.params.id));
  const { rows } = await svc.sheet(req.ctx, req.params.month);
  const row = rows.find((r) => r.id === employee.id);
  const payment = await knex('payroll_payments').where({ employee_id: employee.id, month: req.params.month, business_id: req.ctx.businessId }).first();
  // A paid month shows the figures stored when it was paid; an unpaid month shows the current calculation.
  const slip = payment ? { base: Number(payment.base_salary), bonus: Number(payment.bonus), deductions: Number(payment.deductions), commission: Number(payment.commission), net: Number(payment.net_pay), paidAt: payment.paid_at, method: payment.payment_method, reference: payment.reference }
    : row ? { base: row.baseSalary, bonus: row.bonus, deductions: row.deductions, commission: row.commission, net: row.net } : null;
  res.page('pages/payroll/payslip', { title: req.t('payroll.payslip'), employee, month: req.params.month, slip, paid: Boolean(payment), orders: row ? row.orders : 0, printable: true });
}));

module.exports = router;
