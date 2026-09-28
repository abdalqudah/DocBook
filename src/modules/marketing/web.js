const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const exporter = require('../../core/exporter');
const charts = require('../../core/charts');
const fmt = require('../../core/format');
const engine = require('../finance/engine');
const fin = require('../finance/finance.data');
const svc = require('./marketing.service');

const router = express.Router();
router.use(can('marketing.view'));

async function render(req, res, extra = {}) {
  const d = await fin.load(req.ctx.businessId);
  const month = fin.monthFromQuery(req.query.month, '');
  // Same period rule as the P&L: a campaign belongs to a month if it starts or ends in it.
  let list = d.campaigns.filter((c) => !month || engine.toMonthKey(c.startDate) === month || engine.toMonthKey(c.endDate) === month);
  if (req.query.platform && req.query.platform !== 'all') list = list.filter((c) => c.platform === req.query.platform);
  if (req.query.status && req.query.status !== 'all') list = list.filter((c) => c.status === req.query.status);
  if (req.query.q) { const q = String(req.query.q).toLowerCase(); list = list.filter((c) => `${c.campaignName} ${c.targetProduct || ''}`.toLowerCase().includes(q)); }
  const rows = list.map((c) => ({ ...c, m: engine.campaignMetrics(c) }));
  const tot = rows.reduce((t, c) => ({ cost: t.cost + c.cost, revenueGenerated: t.revenueGenerated + c.revenueGenerated, impressions: t.impressions + c.impressions, clicks: t.clicks + c.clicks, conversions: t.conversions + c.conversions }),
    { cost: 0, revenueGenerated: 0, impressions: 0, clicks: 0, conversions: 0 });
  const totalM = engine.campaignMetrics(tot);
  const platforms = svc.byPlatform(list);
  const cur = req.business.currency; const L = req.locale;
  const money = (v) => fmt.formatCompact(v, cur, L);
  const platformChart = charts.bars({ items: platforms.map((p) => ({ label: res.locals.label('platforms', p.platform), value: p.m.roas, note: `· ${money(p.cost)}` })), fmt: (v) => `${fmt.formatNumber(v, L, 2)}×` });
  const series = fin.monthSeries(d, 12);
  const byMonth = series.map((s) => {
    const cs = d.campaigns.filter((c) => engine.toMonthKey(c.startDate) === s.month || engine.toMonthKey(c.endDate) === s.month);
    return { label: fmt.formatMonth(s.month, L), short: fmt.formatDate(`${s.month}-01`, L, { month: 'short' }), value: cs.reduce((a, c) => a + c.cost, 0), value2: cs.reduce((a, c) => a + c.revenueGenerated, 0) };
  });
  const trend = charts.columns({ points: byMonth, series: [{ key: 'value', cls: 's2' }, { key: 'value2', cls: '' }], title: req.t('marketing.spend_vs_revenue'), fmt: money, height: 220, width: 720,
    tipFmt: (p) => `${req.t('marketing.spend')}: ${money(p.value)} · ${req.t('marketing.revenue')}: ${money(p.value2)}`, labelMax: false });
  res.page('pages/marketing/index', {
    title: req.t('nav.marketing'), rows, tot, totalM, platforms, platformChart, trend, hasTrend: byMonth.some((b) => b.value || b.value2), month, periodOptions: fin.periodOptions(d),
    platformList: svc.PLATFORMS, statuses: svc.STATUSES, best: platforms[0], filtered: ['q', 'platform', 'status'].some((k) => req.query[k] && req.query[k] !== 'all'), ...extra,
  });
}

router.get('/', wrap((req, res) => render(req, res)));
router.get('/export', can('data.export'), wrap(async (req, res) => {
  const d = await fin.load(req.ctx.businessId);
  const t = req.t; const lbl = res.locals.label;
  exporter.send(req, res, {
    name: t('nav.marketing'),
    header: [t('marketing.campaign'), t('marketing.platform'), t('marketing.start'), t('marketing.end'), t('marketing.spend'), t('marketing.impressions'), t('marketing.clicks'), t('marketing.conversions'), t('marketing.revenue'), t('marketing.profit'), 'ROAS', 'ROI %', 'CPC', 'CPA', 'CTR %', t('common.status')],
    rows: d.campaigns.map((c) => { const m = engine.campaignMetrics(c); return [c.campaignName, lbl('platforms', c.platform), c.startDate || '', c.endDate || '', c.cost, c.impressions, c.clicks, c.conversions, c.revenueGenerated, m.netProfit, Number(m.roas.toFixed(2)), Number(m.roi.toFixed(2)), Number(m.cpc.toFixed(3)), Number(m.cpa.toFixed(3)), Number(m.ctr.toFixed(2)), lbl('marketing.statuses', c.status)]; }),
  });
}));
const rerender = (req, res, extra) => render(req, res, { ...extra, openDialog: 'campaign-dialog', formAction: req.originalUrl });
router.post('/', can('marketing.manage'), form(async (req, res) => {
  await svc.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('marketing.saved'));
  res.redirect('/app/marketing');
}, rerender));
router.post('/:id(\\d+)', can('marketing.manage'), form(async (req, res) => {
  await svc.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(req.body._return || '/app/marketing');
}, rerender));
router.post('/:id(\\d+)/delete', can('marketing.manage'), wrap(async (req, res) => {
  await svc.campaigns.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(req.body._return || '/app/marketing');
}));

module.exports = router;
