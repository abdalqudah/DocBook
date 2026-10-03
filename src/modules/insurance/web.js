// Insurance claims statements (/app/insurance-claims): each insurance company's invoices for a period with the
// insurer's share — Excel / PDF, or e-mailed to the company with both attached. billing.view to see and export,
// billing.manage to e-mail. The company id is always checked against the signed-in clinic.
const express = require('express');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const svc = require('./statement.service');

const router = express.Router();
router.use(can('billing.view'));
const errText = (req, err) => { for (const k of [`inscl.err.${err.code}`, `errors.${err.code}`]) { const s = req.t(k); if (s !== k) return s; } return err.message; };
const qs = (p) => `from=${p.from}&to=${p.to}`;

router.get('/', wrap(async (req, res) => {
  const period = svc.periodOf(req.query, req.ctx.today);
  const pid = Number(req.query.provider) || 0;
  const [summary, log] = await Promise.all([svc.summary(req.ctx, period.from, period.to), svc.history(req.ctx)]);
  const st = pid ? await svc.build(req.ctx, pid, period.from, period.to) : null;
  res.page('pages/insurance/claims', { title: req.t('inscl.title'), period, summary, st, log, pageStyles: ['/css/finance.css'] });
}));

router.get('/:pid(\\d+)/export', wrap(async (req, res) => {
  const period = svc.periodOf(req.query, req.ctx.today);
  const st = await svc.build(req.ctx, req.params.pid, period.from, period.to);
  const base = svc.fileBase(st);
  if (req.query.format === 'pdf') {
    const buf = await svc.pdf(req.ctx, st, req.t, req.locale);
    await svc.log(req.ctx, st, 'pdf');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${base}.pdf"`, 'Cache-Control': 'private, no-store' });
    return res.send(buf);
  }
  await svc.log(req.ctx, st, 'xlsx');
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${base}.xlsx"`, 'Cache-Control': 'private, no-store' });
  return res.send(svc.excel(st, req.t, req.locale));
}));

router.post('/:pid(\\d+)/send', can('billing.manage'), wrap(async (req, res) => {
  const period = svc.periodOf(req.body, req.ctx.today);
  const back = `/app/insurance-claims?provider=${Number(req.params.pid)}&${qs(period)}`;
  try {
    const st = await svc.build(req.ctx, req.params.pid, period.from, period.to);
    const locale = ['ar', 'en'].includes(req.body.lang_msg) ? req.body.lang_msg : req.locale;
    const { translator } = require('../../core/i18n'); // eslint-disable-line global-require
    const to = await svc.email(req.ctx, st, { to: req.body.email_to, locale, t: translator(locale) });
    flash(req, 'success', req.t('inscl.sent', { to, n: st.totals.count }));
  } catch (err) {
    if (!(err instanceof AppError) || (err.status >= 500 && err.code !== 'MAIL_FAILED')) throw err;
    flash(req, 'error', errText(req, err));
  }
  res.redirect(back);
}));

module.exports = router;
