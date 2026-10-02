// /app/chat — staff chat of the signed-in clinic: the clinic room and one-to-one conversations.
// Works without JavaScript (the form posts and comes back); with it, new messages arrive every few seconds.
const express = require('express');
const multer = require('multer');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const { wrap } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const svc = require('./chat.service');

const router = express.Router();
const wantsJson = (req) => (req.get('accept') || '').includes('application/json');
const out = (m) => ({ id: m.id, body: m.body, user_id: m.user_id, user_name: m.user_name || '', at: m.created_at, files: m.files || [] });
const upload = multer({ storage: multer.memoryStorage(), limits: { files: svc.MAX_FILES, fileSize: svc.MAX_FILE_BYTES + 1, fields: 10, fieldSize: 10_000 } });
const parseUpload = (req, res, next) => upload.array('files', svc.MAX_FILES)(req, res, (err) => {
  if (err && err.code && String(err.code).startsWith('LIMIT_')) { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'CHAT_FILE_BIG' : 'CHAT_TOO_MANY'; req.body = req.body || {}; return next(); }
  return next(err);
});

router.get('/', wrap(async (req, res) => {
  if (req.query.u) { const c = await svc.direct(req.ctx, req.query.u); return res.redirect(`/app/chat?c=${c.id}`); }
  const [chats, members] = await Promise.all([svc.list(req.ctx, { include: req.query.c }), svc.members(req.ctx)]);
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

// Images and documents (multipart; the CSRF token is checked after parsing, see MULTIPART_ROUTES).
router.post('/:id(\\d+)/upload', parseUpload, verifyCsrfAfterUpload, wrap(async (req, res) => {
  try {
    if (req.uploadError) throw new AppError(req.uploadError, 'Upload refused.', 422);
    const id = await svc.send(req.ctx, req.params.id, req.body.body, req.files);
    if (wantsJson(req)) return res.json({ id });
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 404) throw e;
    const k = `chat.err.${e.code}`; const msg = req.t(k) !== k ? req.t(k) : req.t('chat.send_failed');
    if (wantsJson(req)) return res.status(e.status).json({ error: { code: e.code, message: msg } });
    require('../../routes/helpers').flash(req, 'error', msg); // eslint-disable-line global-require
  }
  return res.redirect(`/app/chat?c=${Number(req.params.id)}#end`);
}));

// An attachment: images open in the page, documents download; never cached, sandboxed.
router.get('/files/:fid(\\d+)', wrap(async (req, res) => {
  const f = await svc.fileOf(req.ctx, req.params.fid);
  const inline = f.mime.startsWith('image/') || (f.mime === 'application/pdf' && req.query.download !== '1');
  res.set({
    'Content-Type': f.mime, 'Content-Length': String(f.data.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=600',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="file-${f.id}.${f.name.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  });
  return res.end(f.data);
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
