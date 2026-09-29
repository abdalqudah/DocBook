// Online payments for staff (/app/payments): the list of card payments taken through the clinic's gateway,
// one payment's details, "check with the provider again" and "Refund" (full refund through the provider; the
// invoice the payment created is voided). billing.view to see, billing.manage to act.
const express = require('express');
const { wrap, flash, back } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { publicBase } = require('../../middleware/web');
const pay = require('./payments.service');

const router = express.Router();
router.use(can('billing.view'));

const errText = (req, e) => { for (const k of [`errors_payments.${e.code}`, `errors.${e.code}`]) { const s = req.t(k); if (s !== k) return s; } return e.message; };
const ASSETS = { pageStyles: ['/css/payments.css'] };

router.get('/', wrap(async (req, res) => {
  const status = ['attention', ...pay.STATUSES].includes(req.query.status) ? req.query.status : 'all';
  const data = await pay.list(req.ctx, { status, page: req.query.page });
  const gw = await pay.gatewayView(req.ctx.businessId);
  res.page('pages/payments/index', { title: req.t('payments.list.title'), status, ...data, gw, ...ASSETS });
}));

router.get('/:id(\\d+)', wrap(async (req, res) => {
  const p = await pay.get(req.ctx, Number(req.params.id));
  let raw = null;
  try { raw = p.raw_result ? JSON.parse(p.raw_result) : null; } catch { raw = null; }
  res.page('pages/payments/show', { title: `${req.t('payments.list.payment')} #${p.id}`, p, raw, ...ASSETS });
}));

router.post('/:id(\\d+)/verify', can('billing.manage'), wrap(async (req, res) => {
  const p = await pay.get(req.ctx, Number(req.params.id));
  try {
    const r = await pay.verify(p, { ip: req.ip, userAgent: req.get('user-agent'), baseUrl: publicBase(req) });
    flash(req, r === 'paid' ? 'success' : 'info', req.t(`payments.list.verify_result.${['paid', 'already', 'pending', 'failed', 'mismatch'].includes(r) ? r : 'failed'}`));
  } catch (e) {
    if (!(e instanceof AppError) || (e.status >= 500 && e.status !== 502)) throw e;
    flash(req, 'error', errText(req, e));
  }
  back(req, res, `/app/payments/${p.id}`);
}));

router.post('/:id(\\d+)/refund', can('billing.manage'), wrap(async (req, res) => {
  try {
    const r = await pay.refund(req.ctx, Number(req.params.id));
    flash(req, 'success', req.t(r.voided ? 'payments.list.refund_done_void' : 'payments.list.refund_done'));
  } catch (e) {
    if (!(e instanceof AppError) || (e.status >= 500 && e.status !== 502)) throw e;
    flash(req, 'error', errText(req, e));
  }
  back(req, res, `/app/payments/${req.params.id}`);
}));

module.exports = router;
