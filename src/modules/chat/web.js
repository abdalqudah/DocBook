// /app/chat — staff chat of the signed-in clinic: the clinic room and one-to-one conversations.
// Works without JavaScript (the form posts and comes back); with it, new messages arrive every few seconds.
const express = require('express');
const { wrap } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const svc = require('./chat.service');

const router = express.Router();
const wantsJson = (req) => (req.get('accept') || '').includes('application/json');
const out = (m) => ({ id: m.id, body: m.body, user_id: m.user_id, user_name: m.user_name || '', at: m.created_at });

router.get('/', wrap(async (req, res) => {
  if (req.query.u) { const c = await svc.direct(req.ctx, req.query.u); return res.redirect(`/app/chat?c=${c.id}`); }
  const [chats, members] = await Promise.all([svc.list(req.ctx), svc.members(req.ctx)]);
  const active = chats.find((c) => String(c.id) === String(req.query.c)) || chats[0];
  const msgs = active ? await svc.messages(req.ctx, active.id) : [];
  if (active && msgs.length) await svc.markRead(req.ctx, active.id, msgs[msgs.length - 1].id);
  if (active) active.unread = 0;
  res.locals.unreadChat = await svc.unreadTotal(req.ctx);
  return res.page('pages/chat/index', { title: req.t('chat.title'), chats, members, active, msgs, pageScripts: ['/js/chat.js'] });
}));

router.get('/unread', wrap(async (req, res) => res.json({ unread: await svc.unreadTotal(req.ctx) })));

router.get('/:id(\\d+)/messages', wrap(async (req, res) => {
  const rows = await svc.messages(req.ctx, req.params.id, { after: Number(req.query.after) || 0 });
  if (rows.length) await svc.markRead(req.ctx, Number(req.params.id), rows[rows.length - 1].id);
  res.json({ data: rows.map(out) });
}));

router.post('/:id(\\d+)', wrap(async (req, res) => {
  try {
    const id = await svc.send(req.ctx, req.params.id, req.body.body);
    if (wantsJson(req)) return res.json({ id });
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 404) throw e;
    if (wantsJson(req)) return res.status(e.status).json({ error: { code: e.code, message: req.t('chat.send_failed') } });
  }
  return res.redirect(`/app/chat?c=${Number(req.params.id)}#end`);
}));

module.exports = router;
