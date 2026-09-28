const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const exporter = require('../../core/exporter');
const charts = require('../../core/charts');
const fmt = require('../../core/format');
const engine = require('../finance/engine');
const fin = require('../finance/finance.data');
const svc = require('./partner.service');

const router = express.Router();
router.use(can('partners.view'));

router.get('/', wrap(async (req, res) => {
  const month = fin.monthFromQuery(req.query.month, '');
  const d = await fin.load(req.ctx.businessId);
  const metrics = engine.computeMetrics(d, month);
  const allTime = month ? engine.computeMetrics(d, '') : metrics;
  const byId = Object.fromEntries(metrics.partnerAllocations.map((a) => [String(a.partnerId), a]));
  const byIdAll = Object.fromEntries(allTime.partnerAllocations.map((a) => [String(a.partnerId), a]));
  const equity = engine.equityTotal(d.partners);
  const capital = d.partners.reduce((s, p) => s + p.initialInvestment + p.additionalContributions, 0);
  const withdrawn = d.partners.reduce((s, p) => s + p.totalWithdrawn, 0);
  const split = charts.donut({ items: d.partners.map((p) => ({ label: p.name, value: p.currentEquityPercent })), fmt: (v) => `${v}%`, title: req.t('partners.equity_split'), otherLabel: req.t('dashboard.other') });
  res.page('pages/partners/index', { title: req.t('nav.partners'), partners: d.partners, month, periodOptions: fin.periodOptions(d), metrics, byId, byIdAll, equity, capital, withdrawn, split, showProfit: req.ctx.permissions.has('profits.view') });
}));

router.get('/export', can('data.export'), wrap(async (req, res) => {
  const d = await fin.load(req.ctx.businessId);
  const m = engine.computeMetrics(d, '');
  const t = req.t;
  exporter.send(req, res, {
    name: t('nav.partners'),
    header: [t('common.name'), t('common.phone'), t('common.email'), t('partners.equity'), t('partners.initial'), t('partners.additional'), t('partners.total_invested'), t('partners.withdrawn'), t('partners.allocated_all'), t('partners.net_payable'), t('partners.join_date')],
    rows: d.partners.map((p) => { const a = m.partnerAllocations.find((x) => x.partnerId === p.id) || {}; return [p.name, p.phone || '', p.email || '', p.currentEquityPercent, p.initialInvestment, p.additionalContributions, p.initialInvestment + p.additionalContributions, p.totalWithdrawn, req.ctx.permissions.has('profits.view') ? a.allocatedProfit : '', req.ctx.permissions.has('profits.view') ? a.netPayable : '', p.joinDate || '']; }),
  });
}));

// ---- Create / edit
const renderForm = async (req, res, extra = {}) => {
  const id = req.params.id ? Number(req.params.id) : null;
  const partner = id ? await svc.partners.get(req.ctx, id) : null;
  const d = await fin.load(req.ctx.businessId);
  const othersEquity = d.partners.filter((p) => p.id !== id).reduce((s, p) => s + p.currentEquityPercent, 0);
  res.page('pages/partners/form', { title: partner ? req.t('partners.edit') : req.t('partners.add'), partner, othersEquity, ...extra });
};
router.get('/new', can('partners.manage'), wrap((req, res) => renderForm(req, res)));
router.post('/new', can('partners.manage'), form(async (req, res) => {
  const id = await svc.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('partners.saved'));
  res.redirect(`/app/partners/${id}`);
}, renderForm));
router.get('/:id(\\d+)/edit', can('partners.manage'), wrap((req, res) => renderForm(req, res)));
router.post('/:id(\\d+)/edit', can('partners.manage'), form(async (req, res) => {
  await svc.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(`/app/partners/${req.params.id}`);
}, renderForm));
router.post('/:id(\\d+)/delete', can('partners.manage'), wrap(async (req, res) => {
  await svc.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('partners.deleted'));
  res.redirect('/app/partners');
}));

// ---- Detail + ledger
const renderShow = async (req, res, extra = {}) => {
  const id = Number(req.params.id);
  const partner = await svc.partners.get(req.ctx, id);
  const d = await fin.load(req.ctx.businessId);
  const month = fin.monthFromQuery(req.query.month, '');
  const m = engine.computeMetrics(d, month);
  const mAll = engine.computeMetrics(d, '');
  const alloc = m.partnerAllocations.find((a) => a.partnerId === id) || {};
  const allocAll = mAll.partnerAllocations.find((a) => a.partnerId === id) || {};
  // Monthly allocated profit over the last 12 months.
  const series = fin.monthSeries(d, 12).map((s) => ({ label: fmt.formatMonth(s.month, req.locale), short: fmt.formatDate(`${s.month}-01`, req.locale, { month: 'short' }), value: s.netProfit * (Number(partner.current_equity_percent) / 100) }));
  const chart = charts.columns({ points: series, title: req.t('partners.monthly_share'), fmt: (v) => fmt.formatCompact(v, req.business.currency, req.locale), height: 200, width: 640 });
  res.page('pages/partners/show', {
    title: partner.name, partner, alloc, allocAll, month, periodOptions: fin.periodOptions(d), chart, hasSeries: series.some((s) => s.value),
    txs: await svc.transactions(req.ctx, id), showProfit: req.ctx.permissions.has('profits.view'), ...extra,
  });
};
router.get('/:id(\\d+)', wrap((req, res) => renderShow(req, res)));
router.post('/:id(\\d+)/transactions', can('partners.manage'), form(async (req, res) => {
  await svc.addTransaction(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t(req.body.type === 'withdrawal' ? 'partners.withdrawal_saved' : 'partners.contribution_saved'));
  res.redirect(`/app/partners/${req.params.id}`);
}, (req, res, extra) => renderShow(req, res, { ...extra, openDialog: 'tx-dialog' })));
router.post('/:id(\\d+)/transactions/:tx(\\d+)/delete', can('partners.manage'), wrap(async (req, res) => {
  await svc.deleteTransaction(req.ctx, Number(req.params.id), Number(req.params.tx));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(`/app/partners/${req.params.id}`);
}));

// ---- Profit distribution workflow
router.get('/distribution', can('profits.view'), wrap(async (req, res) => {
  const month = fin.monthFromQuery(req.query.month);
  const { metrics, equityTotal } = await svc.preview(req.ctx, month);
  const d = await fin.load(req.ctx.businessId);
  res.page('pages/partners/distribution', { title: req.t('partners.distribution'), month, periodOptions: fin.periodOptions(d), metrics, equityTotal, history: await svc.distributions(req.ctx) });
}));
router.post('/distribution', can('partners.manage'), can('profits.view'), wrap(async (req, res) => {
  const month = fin.monthFromQuery(req.body.month);
  const id = await svc.recordDistribution(req.ctx, month, { payout: req.body.payout, note: req.body.note });
  flash(req, 'success', req.t('partners.distribution_recorded'));
  res.redirect(`/app/partners/distribution/${id}`);
}));
router.get('/distribution/:id(\\d+)', can('profits.view'), wrap(async (req, res) => {
  const dist = await svc.distribution(req.ctx, Number(req.params.id));
  res.page('pages/partners/statement', { title: req.t('partners.statement_title'), dist, printable: true });
}));

module.exports = router;
