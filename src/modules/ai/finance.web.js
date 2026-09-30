// AI finance & management assistant (worker: aifinance). Mounted at '/' inside /app.
//  • GET  /finance/assistant                     page: month figures, last analysis, chat (finance.view)
//  • POST /finance/assistant/analyze             monthly analysis (structured output) → redirect / JSON
//  • POST /finance/assistant/chat                one chat turn (tool loop) → JSON { html } / redirect without JS
//  • POST /finance/assistant/chat/clear          clears this user's conversation (pending actions are cancelled)
//  • POST /finance/assistant/actions/:id/confirm executes a proposed action (expenses.manage / supplies.manage NOW)
//  • POST /finance/assistant/actions/:id/cancel  cancels a proposed action
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const { can, isJson } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const lib = require('../clinic/records.lib');
const expenseSvc = require('../expenses/expense.service');
const fin = require('./finance.service');

const router = express.Router();
const BASE = '/app/finance/assistant';

function tr(req, code) {
  for (const k of [`errors_aifin.${code}`, `errors_ai.${code}`, `errors.${code}`]) { const s = req.t(k); if (s !== k) return s; }
  return req.t('errors_ai.AI_API_ERROR');
}

function monthOf(req, value) {
  const cur = (req.ctx.today || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const m = String(value || '');
  return lib.MONTH.test(m) && m <= cur ? m : cur;
}
const monthOptions = (cur, n = 13) => Array.from({ length: n }, (_, i) => lib.addMonths(cur, -i));

async function labels(req, res) {
  const { custom } = await expenseSvc.categories(req.ctx.businessId);
  const map = Object.fromEntries(custom.map((c) => [c.key, c.name]));
  return (key) => map[key] || res.locals.label('categories', key);
}

async function render(req, res, extra = {}) {
  const { ctx } = req;
  const month = monthOf(req, req.query.month);
  const { platform, fin: settings, code } = await fin.access(ctx);
  const current = (ctx.today || '').slice(0, 7);
  const [figures, last, conversation, usage, catName] = await Promise.all([
    fin.monthlyFigures(ctx, month, req.locale),
    code ? null : fin.lastRun(ctx, month),
    code ? [] : fin.conversation(ctx),
    fin.usage(ctx),
    labels(req, res),
  ]);
  res.page('pages/ai/finance', {
    title: req.t('aifin.title'), month, months: monthOptions(current), figures, last, conversation, usage, catName,
    denied: code, deniedText: code ? tr(req, code) : null, platform, settings,
    pageStyles: ['/css/aifinance.css'], pageScripts: ['/js/aifinance.js'],
    ...extra,
  });
}

/** Renders the chat messages partial to a string. */
function renderMessages(req, res, messages, catName) {
  return new Promise((resolve, reject) => {
    res.render('pages/ai/finance_messages', { messages, catName }, (err, html) => (err ? reject(err) : resolve(html)));
  });
}

function sendError(req, res, err, redirectTo) {
  if (!(err instanceof AppError)) throw err;
  const code = err.code || 'AI_API_ERROR';
  let message = code === 'NOT_FOUND' ? req.t('errors_aifin.ACTION_NOT_FOUND') : tr(req, code);
  let details = null;
  if (code === 'VALIDATION_FAILED' && err.details) {
    details = Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k, translateMessage(req.locale, v)]));
    message = `${req.t('errors_aifin.ACTION_INVALID')} ${Object.values(details).join(' ')}`;
  }
  if (isJson(req)) return res.status(err.status >= 400 && err.status < 600 ? err.status : 500).json({ ok: false, error: { code, message, details } });
  flash(req, 'error', message);
  return res.redirect(redirectTo);
}

router.use('/finance/assistant', can('finance.view'));

router.get('/finance/assistant', wrap((req, res) => render(req, res)));

router.post('/finance/assistant/analyze', wrap(async (req, res) => {
  const month = monthOf(req, req.body.month);
  const back = `${BASE}?month=${month}#analysis`;
  try {
    const out = await fin.analyze(req.ctx, month, { locale: req.locale });
    if (isJson(req)) return res.json({ ok: true, data: out });
    flash(req, 'success', req.t('aifin.analysis_done'));
    return res.redirect(back);
  } catch (err) {
    return sendError(req, res, err, back);
  }
}));

router.post('/finance/assistant/chat', wrap(async (req, res) => {
  const back = `${BASE}${req.body.month && lib.MONTH.test(req.body.month) ? `?month=${req.body.month}` : ''}#chat`;
  try {
    const out = await fin.chat(req.ctx, req.body.message, { locale: req.locale });
    if (!isJson(req)) return res.redirect(back);
    const messages = await fin.conversation(req.ctx, { afterId: out.userMessageId - 1 });
    const html = await renderMessages(req, res, messages, await labels(req, res));
    const usage = await fin.usage(req.ctx);
    return res.json({ ok: true, data: { status: out.status, html, usage } });
  } catch (err) {
    return sendError(req, res, err, back);
  }
}));

router.post('/finance/assistant/chat/clear', wrap(async (req, res) => {
  await fin.clearConversation(req.ctx);
  flash(req, 'success', req.t('aifin.chat_cleared'));
  res.redirect(`${BASE}#chat`);
}));

router.post('/finance/assistant/actions/:id(\\d+)/:op(confirm|cancel)', wrap(async (req, res) => {
  const back = `${BASE}#chat`;
  try {
    const a = req.params.op === 'confirm' ? await fin.confirmAction(req.ctx, Number(req.params.id)) : await fin.cancelAction(req.ctx, Number(req.params.id));
    if (isJson(req)) {
      const catName = await labels(req, res);
      const html = await new Promise((resolve, reject) => {
        res.render('pages/ai/finance_action', { a, catName }, (err, out) => (err ? reject(err) : resolve(out)));
      });
      return res.json({ ok: true, data: { status: a.status, html } });
    }
    flash(req, 'success', req.t(req.params.op === 'confirm' ? `aifin.done_${a.kind}` : 'aifin.action_cancelled'));
    return res.redirect(back);
  } catch (err) {
    if (err instanceof AppError && err.code === 'PERMISSION_DENIED') {
      const message = req.t('errors_aifin.ACTION_FORBIDDEN');
      if (isJson(req)) return res.status(403).json({ ok: false, error: { code: 'PERMISSION_DENIED', message } });
      flash(req, 'error', message);
      return res.redirect(back);
    }
    return sendError(req, res, err, back);
  }
}));

module.exports = router;
