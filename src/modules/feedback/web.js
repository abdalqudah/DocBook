// The clinic owner's answer to "how likely are you to recommend us" (or "not now"). Mounted under /app.
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const svc = require('./feedback.service');

const router = express.Router();
router.post('/feedback', wrap(async (req, res) => {
  try {
    const s = await svc.answer(req.ctx, req.business, req.body);
    if (s !== null) flash(req, 'success', req.t('nps.thanks'));
  } catch (e) {
    if (!(e instanceof AppError) || !e.details) throw e;
    flash(req, 'error', req.t('nps.pick'));
  }
  const back = String(req.get('referer') || '');
  res.redirect(back.includes('/app') ? back.replace(/^https?:\/\/[^/]+/, '') : '/app');
}));

module.exports = router;
