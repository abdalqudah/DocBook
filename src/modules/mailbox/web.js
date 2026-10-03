// A staff member's own e-mail (/app/mail): connect, folders, read, reply / forward, write with attachments — uploaded
// files and the clinic's papers (?attach=prescription:12). Personal: every route works on the signed-in member's own
// account only. Automatic patient messages still go out from the clinic's address.
const express = require('express');
const multer = require('multer');
const { wrap, form, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const svc = require('./mailbox.service');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10, fields: 40 } });
const parseFiles = (req, res, next) => upload.array('files', 10)(req, res, (err) => { if (err) req.uploadError = err; next(); });

const errText = (req, e) => { const k = `mailbox.err.${e.code}`; const s = req.t(k); return s !== k ? s : e.message; };
const folderOf = (v) => (typeof v === 'string' && v && v.length < 200 && !/[\r\n\0]/.test(v) ? v : 'INBOX');
const uidOf = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new AppError('NOT_FOUND', 'Message not found.', 404); return n; };

// A recently opened message, kept a minute so the page, its body frame and its files are fetched once.
const recent = new Map();
async function message(req, r, folder, uid) {
  const key = `${req.ctx.businessId}:${req.ctx.userId}:${folder}:${uid}`;
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.m;
  const m = await svc.read(r, folder, uid);
  recent.set(key, { m, at: Date.now() });
  if (recent.size > 200) recent.delete(recent.keys().next().value);
  return m;
}

const page = (req, res, view, data) => res.page(`pages/mailbox/${view}`, { pageStyles: ['/css/mailbox.css'], pageScripts: ['/js/mailbox.js'], ...data });

// ---------------------------------------------------------------- the account
async function settingsPage(req, res, extra = {}) {
  const r = await svc.mine(req.ctx);
  page(req, res, 'settings', { title: req.t('mailbox.settings_title'), acc: svc.view(r), guessFor: svc.guess(req.user.email), me: { email: req.user.email, name: req.user.name }, ...extra });
}
router.get('/settings', wrap((req, res) => settingsPage(req, res)));
router.post('/settings', wrap(async (req, res) => {
  try { await svc.connect(req.ctx, req.body); } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    res.status(422);
    const why = ['MAILBOX_IMAP_LOGIN', 'MAILBOX_SMTP_LOGIN'].includes(e.code) ? ` — ${e.message}` : ''; // the server's own words help (e.g. an app password is needed)
    return settingsPage(req, res, { old: { ...req.body, password: '' }, errors: e.details || {}, connectError: e.code === 'VALIDATION_FAILED' ? null : errText(req, e) + why });
  }
  flash(req, 'success', req.t('mailbox.connected'));
  return res.redirect('/app/mail');
}));
router.post('/disconnect', wrap(async (req, res) => {
  await svc.disconnect(req.ctx);
  flash(req, 'success', req.t('mailbox.disconnected'));
  res.redirect('/app/mail/settings');
}));

// Everything else needs a connected account.
router.use(wrap(async (req, res, next) => {
  req.mailbox = await svc.mine(req.ctx);
  if (!req.mailbox) return res.redirect('/app/mail/settings');
  return next();
}));

// ---------------------------------------------------------------- reading
router.get('/', wrap(async (req, res) => {
  const folder = folderOf(req.query.f);
  const q = String(req.query.q || '').trim().slice(0, 100);
  let folders = []; let box = null; let error = null;
  try { [folders, box] = [await svc.folders(req.mailbox), await svc.list(req.mailbox, folder, req.query.page, q)]; } catch (e) {
    if (!(e instanceof AppError)) throw e;
    error = errText(req, e);
  }
  page(req, res, 'index', { title: req.t('mailbox.title'), acc: svc.view(req.mailbox), folders, folder, box, q, error });
}));

router.get('/m', wrap(async (req, res) => {
  const folder = folderOf(req.query.f); const uid = uidOf(req.query.uid);
  const m = await message(req, req.mailbox, folder, uid);
  page(req, res, 'message', { title: m.subject || req.t('mailbox.no_subject'), acc: svc.view(req.mailbox), m, folder });
}));

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// The message body inside a sandboxed frame: no scripts, no forms, no remote content unless asked (images=1).
router.get('/m/body', wrap(async (req, res) => {
  const m = await message(req, req.mailbox, folderOf(req.query.f), uidOf(req.query.uid));
  const images = req.query.images === '1';
  let html;
  if (m.html) {
    html = String(m.html);
    for (const a of m.attachments) if (a.cid && a.content && /^image\//.test(a.contentType || '')) html = html.split(`cid:${a.cid}`).join(`data:${a.contentType};base64,${a.content.toString('base64')}`);
  } else html = `<pre style="white-space:pre-wrap;font:inherit;margin:0">${escapeHtml(m.text)}</pre>`;
  res.set({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? ' https: http:' : ''}; font-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,
  });
  return res.send(`<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:16px;font-family:Tahoma,Arial,sans-serif;font-size:14px;line-height:1.6;color:#222;background:#fff;overflow-wrap:break-word}img{max-width:100%;height:auto}</style></head><body dir="auto">${html}</body></html>`);
}));

router.get('/m/file', wrap(async (req, res) => {
  const m = await message(req, req.mailbox, folderOf(req.query.f), uidOf(req.query.uid));
  const a = m.attachments[Number(req.query.i)];
  if (!a || !a.content) throw new AppError('NOT_FOUND', 'File not found.', 404);
  res.set({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'",
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}` });
  return res.send(a.content);
}));

router.post('/m/trash', wrap(async (req, res) => {
  const folder = folderOf(req.body.f);
  await svc.trash(req.mailbox, folder, uidOf(req.body.uid));
  flash(req, 'success', req.t('mailbox.trashed'));
  res.redirect(`/app/mail?f=${encodeURIComponent(folder)}`);
}));

// ---------------------------------------------------------------- writing
async function composePage(req, res, extra = {}) {
  const papers = [].concat(req.query.attach || (req.body && req.body.papers) || []).map(String).filter((p) => /^[a-z]+:\d+$/.test(p)).slice(0, 10);
  const items = []; let suggestTo = '';
  for (const p of papers) { // eslint-disable-line no-restricted-syntax
    const [kind, id] = p.split(':');
    try {
      const share = require('../share/share.service'); // eslint-disable-line global-require
      if (!svc.DOC_KINDS.includes(kind) || !(share.PERMS[kind] || []).some((x) => req.ctx.permissions.has(x))) continue; // eslint-disable-line no-continue
      const doc = await share.target(req.ctx, kind, id); // eslint-disable-line no-await-in-loop
      if (!suggestTo) suggestTo = (await share.emailOf(req.ctx, doc)) || ''; // eslint-disable-line no-await-in-loop
      items.push({ key: p, kind, label: share.itemName(req.t, { kind, id: Number(id), ...(doc.label ? { label: doc.label } : {}) }) || req.t(`share.doc.${kind}`, doc.label || {}), patient: doc.name });
    } catch (e) { if (!(e instanceof AppError)) throw e; }
  }
  let reply = null;
  if (req.query.reply || req.query.forward) {
    const [f, u] = String(req.query.reply || req.query.forward).split('|');
    try {
      const m = await message(req, req.mailbox, folderOf(f), uidOf(u));
      const quoted = `\n\n${req.t('mailbox.quote_line', { date: m.date ? new Date(m.date).toISOString().slice(0, 16).replace('T', ' ') : '', name: (m.from && (m.from.name || m.from.address)) || '' })}\n${String(m.text || '').split('\n').map((l) => `> ${l}`).join('\n')}`;
      reply = req.query.reply
        ? { to: m.from ? m.from.address : '', subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, text: quoted, in_reply_to: m.messageId, references: [...m.references, m.messageId].filter(Boolean).join(' ') }
        : { to: '', subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`, text: quoted };
    } catch (e) { if (!(e instanceof AppError)) throw e; }
  }
  const returnTo = [req.query.return_to, req.body && req.body.return_to].find((x) => typeof x === 'string' && /^\/app\/[\w\-/?=&.%#]*$/.test(x) && !x.startsWith('//')) || '';
  page(req, res, 'compose', { title: req.t('mailbox.compose'), acc: svc.view(req.mailbox), items, returnTo, draft: { to: req.query.to || suggestTo, cc: '', subject: '', text: '', ...(reply || {}), ...((req.body && req.body.to !== undefined) ? req.body : {}) }, ...extra });
}
router.get('/compose', wrap((req, res) => composePage(req, res)));
router.post('/send', parseFiles, verifyCsrfAfterUpload, wrap(async (req, res) => {
  if (req.uploadError) { res.status(422); return composePage(req, res, { sendError: req.t('mailbox.err.MAILBOX_TOO_BIG') }); }
  const papers = [].concat(req.body.papers || []).map(String).filter((p) => /^[a-z]+:\d+$/.test(p)).slice(0, 10);
  try {
    await svc.send(req.ctx, req.mailbox, req.body, { files: req.files || [], papers, locale: req.locale });
  } catch (e) {
    if (!(e instanceof AppError) || e.status === 403 || e.status === 404) throw e;
    res.status(422);
    req.query.attach = papers;
    return composePage(req, res, { errors: e.details || {}, sendError: e.code === 'VALIDATION_FAILED' ? null : errText(req, e) });
  }
  flash(req, 'success', req.t('mailbox.sent'));
  const back = typeof req.body.return_to === 'string' && /^\/app\/[\w\-/?=&.%#]*$/.test(req.body.return_to) && !req.body.return_to.startsWith('//') ? req.body.return_to : '/app/mail';
  return res.redirect(back);
}));

/** For every app page: does this member have an e-mail connected (the "send from my e-mail" buttons)? */
router.locals = wrap(async (req, res, next) => {
  if (req.method === 'GET' && req.ctx && req.ctx.userId) res.locals.myMailbox = Boolean(await require('../../db/knex')('staff_mailboxes').where({ business_id: req.ctx.businessId, user_id: req.ctx.userId }).first('id')); // eslint-disable-line global-require
  next();
});

module.exports = router;
