// Google Sheets export and clinic media library (worker: integrations). Mounted at '/' inside /app.
//   GET  /settings/google-sheets                      status, export options, connection, run log   data.manage | data.export
//   POST /settings/google-sheets/options              what is exported, language, period, daily run  data.manage
//   GET  /settings/google-sheets/connect              → Google consent (drive.file, offline)          data.manage
//   GET  /settings/google-sheets/callback             ← Google (stores the refresh token encrypted)   data.manage
//   POST /settings/google-sheets/webhook/start        Apps Script method: new shared secret           data.manage
//   POST /settings/google-sheets/webhook              save the web-app URL and test it                 data.manage
//   POST /settings/google-sheets/test                 test the connection                              data.manage
//   POST /settings/google-sheets/disconnect           remove every stored credential                   data.manage
//   POST /settings/google-sheets/run                  export now                                        data.export
//   GET  /settings/media                              library (grid, search, folders)                  settings.manage
//   POST /settings/media/upload                       upload (multipart; JSON for the picker)          settings.manage
//   POST /settings/media/:id                          rename, folder, alt text, public                  settings.manage
//   POST /settings/media/:id/delete                   delete (confirmation when in use)                 settings.manage
//   POST /settings/media/page                         clinic page cover + gallery                       settings.manage
//   GET  /media/api                                   JSON list for the picker                          settings.manage
//   GET  /media/:id                                   the file, for members of the clinic
const express = require('express');
const multer = require('multer');
const config = require('../../config');
const { AppError } = require('../../core/errors');
const { dictionaries, translateMessage } = require('../../core/i18n');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const { render } = require('../settings/common');
const google = require('../auth/google.service');
const sheets = require('./sheets.service');
const media = require('./media.service');

const router = express.Router();
const ASSETS = { pageScripts: ['/js/admin.js', '/js/integrations.js'], pageStyles: ['/css/admin.css', '/css/integrations.css'] };
const FILE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cross-Origin-Resource-Policy': 'same-origin' };

/** Text for an error code: this area's table first, then the shared one. */
function errText(req, e) {
  for (const k of [`errors_integrations.${e.code}`, `errors.${e.code}`]) { const s = req.t(k); if (s !== k) return s; }
  return e.message;
}
/** Field messages authored in English: this area's own table, then the shared vmsg table. */
function vmsg(locale, text) {
  const own = ((dictionaries[locale] || {}).errors_integrations || {}).vmsg || {};
  if (own[text]) return own[text];
  return locale === 'en' ? text : translateMessage(locale, text);
}
/** Stored run failure "CODE:detail" → readable text. */
function reasonText(req, stored) {
  if (!stored) return '';
  const i = String(stored).indexOf(':');
  const code = i >= 0 ? stored.slice(0, i) : stored;
  const detail = i >= 0 ? stored.slice(i + 1) : '';
  const key = `errors_integrations.${code}`;
  const text = req.t(key);
  if (code === 'OTHER' || text === key) return `${req.t('errors_integrations.OTHER')}${detail ? ` (${detail.slice(0, 160)})` : ''}`;
  return ['GSHEETS_GOOGLE', 'GSHEETS_WEBHOOK_FAILED', 'GSHEETS_NETWORK', 'GSHEETS_WEBHOOK_NETWORK'].includes(code) && detail ? `${text} (${detail.replace(/^[^(]*\(|\)\.?$/g, '').slice(0, 160)})` : text;
}

// ================================================================ Google Sheets
const sheetsGate = canAny('data.manage', 'data.export');

async function sheetsPage(req, res, extra = {}) {
  const [cfg, runs, client] = await Promise.all([sheets.get(req.ctx.businessId), sheets.runs(req.ctx.businessId), sheets.oauthClient()]);
  const manage = req.ctx.permissions.has('data.manage');
  return render(req, res, 'google-sheets', 'sheets', {
    title: req.t('gsheets.title'), cfg, runs, manage, oauthReady: Boolean(client), redirectUri: sheets.redirectUri(),
    script: manage && cfg.webhookSecret ? sheets.appsScript(cfg.webhookSecret) : null,
    TABS: sheets.TABS, MONTHS: sheets.MONTHS, reasonText: (s) => reasonText(req, s), ...ASSETS, ...extra,
  });
}

/** Expected failures → a flash message (or a re-rendered form for validation errors). */
const act = (fn, back = '/app/settings/google-sheets') => wrap(async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (!(e instanceof AppError) || (e.status >= 500 && e.status !== 502)) throw e;
    if (e.code === 'VALIDATION_FAILED' && e.details) {
      res.status(422);
      const errors = Object.fromEntries(Object.entries(e.details).map(([k, v]) => [k, vmsg(req.locale, v)]));
      return sheetsPage(req, res, { errors, old: req.body, formError: { code: e.code, message: req.t('errors.VALIDATION_FAILED') } });
    }
    flash(req, 'error', errText(req, e));
  }
  if (!res.headersSent) res.redirect(back);
  return undefined;
});

router.get('/settings/google-sheets', sheetsGate, wrap((req, res) => sheetsPage(req, res)));

router.post('/settings/google-sheets/options', can('data.manage'), act(async (req) => {
  await sheets.saveOptions(req.ctx, req.body);
  flash(req, 'success', req.t('gsheets.options_saved'));
}, '/app/settings/google-sheets#options'));

/** Google sends the browser back to APP_URL, so the flow starts there (the session cookie is per host). */
function appHostRedirect(req) {
  if (!process.env.APP_URL) return null;
  let appHost;
  try { appHost = new URL(config.appUrl).host.toLowerCase(); } catch { return null; }
  return String(req.get('host') || '').toLowerCase() === appHost ? null : `${google.appBase()}${req.originalUrl}`;
}

router.get('/settings/google-sheets/connect', can('data.manage'), act(async (req, res) => {
  const other = appHostRedirect(req);
  if (other) return res.redirect(other);
  const { url, pending } = await sheets.startOAuth();
  req.session.gsheetsOAuth = { ...pending, businessId: req.ctx.businessId };
  await new Promise((resolve) => { req.session.save(() => resolve()); });
  return res.redirect(url);
}));

router.get('/settings/google-sheets/callback', can('data.manage'), act(async (req) => {
  const pending = req.session.gsheetsOAuth;
  delete req.session.gsheetsOAuth;
  if (pending && pending.businessId !== req.ctx.businessId) throw new AppError('GSHEETS_STATE', 'Started for another clinic.', 422);
  const r = await sheets.finishOAuth(req.ctx, pending, req.query);
  flash(req, 'success', r.email ? req.t('gsheets.connected_as', { email: r.email }) : req.t('gsheets.connected'));
}));

router.post('/settings/google-sheets/webhook/start', can('data.manage'), act(async (req) => {
  const cur = await sheets.get(req.ctx.businessId);
  await sheets.startWebhook(req.ctx);
  flash(req, cur.webhookSecret ? 'info' : 'success', req.t(cur.webhookSecret ? 'gsheets.secret_rotated' : 'gsheets.webhook_started'));
}, '/app/settings/google-sheets#apps-script'));

router.post('/settings/google-sheets/webhook', can('data.manage'), act(async (req) => {
  const r = await sheets.saveWebhook(req.ctx, req.body.webhook_url);
  if (r.ok) flash(req, 'success', r.spreadsheet ? req.t('gsheets.test_ok_named', { name: r.spreadsheet }) : req.t('gsheets.test_ok'));
  else flash(req, 'error', `${req.t('gsheets.saved_test_failed')} ${errText(req, r)}`);
}));

router.post('/settings/google-sheets/test', can('data.manage'), act(async (req) => {
  const r = await sheets.test(req.ctx.businessId);
  if (r.ok) flash(req, 'success', r.spreadsheet ? req.t('gsheets.test_ok_named', { name: r.spreadsheet }) : req.t('gsheets.test_ok'));
  else flash(req, 'error', `${req.t('gsheets.test_failed')} ${errText(req, r)}`);
}));

router.post('/settings/google-sheets/disconnect', can('data.manage'), act(async (req) => {
  await sheets.disconnect(req.ctx);
  flash(req, 'success', req.t('gsheets.disconnected'));
}));

router.post('/settings/google-sheets/run', can('data.export'), act(async (req) => {
  const r = await sheets.run(req.ctx.businessId, { trigger: 'manual', userId: req.ctx.userId, ip: req.ctx.ip });
  if (r.status === 'ok') flash(req, 'success', req.t('gsheets.run_ok', { n: r.rows_total, tabs: r.tabs.length }));
  else if (r.status === 'partial') flash(req, 'error', `${req.t('gsheets.run_partial', { ok: r.tabs.filter((x) => x.ok).length, all: r.tabs.length })} ${reasonText(req, r.error)}`);
  else flash(req, 'error', `${req.t('gsheets.run_failed')} ${reasonText(req, r.error)}`);
}));

// ================================================================ media library
const LIST_KINDS = ['', 'image', 'pdf'];

async function mediaPage(req, res, extra = {}) {
  const q = String(req.query.q || '').slice(0, 80);
  const folder = typeof req.query.folder === 'string' && req.query.folder !== '' ? req.query.folder : null;
  const kind = LIST_KINDS.includes(req.query.kind) ? req.query.kind : '';
  const [items, folders, stats] = await Promise.all([media.list(req.ctx.businessId, { q, folder, kind }), media.folders(req.ctx.businessId), media.stats(req.ctx.businessId)]);
  return render(req, res, 'media', 'media', {
    title: req.t('media_lib.title'), items, folders, stats, filters: { q, folder, kind }, maxBytes: media.MAX_BYTES, ...ASSETS, ...extra,
  });
}

router.get(['/settings/media', '/website/media'], canAny('website.edit', 'settings.manage'), wrap(async (req, res) => {
  res.locals.portalMedia = await media.pageMedia(req.ctx.businessId); // the clinic page's cover + gallery, on the same page
  return mediaPage(req, res);
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: media.MAX_BYTES + 1, files: 10, fields: 12, parts: 24 } });
const uploadFiles = (req, res, next) => upload.array('files', 10)(req, res, (e) => {
  if (e) req.uploadError = e.code === 'LIMIT_FILE_SIZE' ? 'MEDIA_TOO_BIG' : e.code === 'LIMIT_FILE_COUNT' ? 'MEDIA_TOO_MANY' : 'MEDIA_TYPE';
  next();
});
const wantsJson = (req) => /json/.test(String(req.get('accept') || ''));
const itemJson = (req, m) => ({
  id: m.id, name: m.name, url: m.url, mime: m.mime, isImage: m.isImage, width: m.width, height: m.height, size: m.size,
  folder: m.folder, alt: (req.locale === 'en' ? m.alt_en || m.alt_ar : m.alt_ar || m.alt_en) || '', isPublic: m.is_public,
});

router.post('/settings/media/upload', canAny('website.edit', 'settings.manage'), uploadFiles, verifyCsrfAfterUpload, wrap(async (req, res) => {
  const saved = []; const errors = [];
  if (req.uploadError) errors.push({ name: '', message: errText(req, { code: req.uploadError, message: '' }) });
  else if (!req.files || !req.files.length) errors.push({ name: '', message: errText(req, { code: 'MEDIA_EMPTY', message: '' }) });
  for (const f of req.files || []) {
    try {
      saved.push(await media.upload(req.ctx, f, { folder: req.body.folder, alt_ar: req.files.length === 1 ? req.body.alt_ar : '', alt_en: req.files.length === 1 ? req.body.alt_en : '', is_public: req.body.is_public })); // eslint-disable-line no-await-in-loop
    } catch (e) {
      if (!(e instanceof AppError) || e.status >= 500) throw e;
      errors.push({ name: String(f.originalname || '').slice(0, 120), message: errText(req, e) });
    }
  }
  if (wantsJson(req)) return res.status(saved.length ? 200 : 422).json({ data: saved.map((m) => itemJson(req, m)), errors });
  if (saved.length) flash(req, 'success', req.t('media_lib.uploaded', { n: saved.length }));
  errors.forEach((er) => flash(req, 'error', er.name ? `${er.name}: ${er.message}` : er.message));
  const back = String(req.body.return || '');
  return res.redirect(/^\/app\/(?:settings|website)\/[a-z-]+$/.test(back) ? back : '/app/website/media');
}));

router.post('/settings/media/page', canAny('website.edit', 'settings.manage'), wrap(async (req, res) => {
  try {
    await media.setPageMedia(req.ctx, req.body);
    flash(req, 'success', req.t('media_lib.page_saved'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', errText(req, e));
  }
  res.redirect('/app/website/media#page-media');
}));

router.post('/settings/media/:id(\\d+)', canAny('website.edit', 'settings.manage'), wrap(async (req, res) => {
  try {
    const body = { ...req.body };
    if (body.public_field === '1' && body.is_public === undefined) body.is_public = '0'; // unchecked box
    await media.update(req.ctx, req.params.id, body);
    flash(req, 'success', req.t('media_lib.updated'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', errText(req, e));
  }
  res.redirect('/app/website/media');
}));

router.post('/settings/media/:id(\\d+)/delete', canAny('website.edit', 'settings.manage'), wrap(async (req, res) => {
  try {
    await media.remove(req.ctx, req.params.id, { force: req.body.force === '1' });
    flash(req, 'success', req.t('media_lib.deleted'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', e.code === 'MEDIA_IN_USE' ? req.t('errors_integrations.MEDIA_IN_USE') : errText(req, e));
  }
  res.redirect('/app/website/media');
}));

// Loader for the clinic page settings (Settings → Clinic page): the cover/gallery panel reads res.locals.portalMedia.
router.get('/settings/portal', (req, res, next) => {
  if (!req.ctx.permissions.has('settings.manage')) return next();
  return media.pageMedia(req.ctx.businessId).then((m) => { res.locals.portalMedia = m; next(); }, next);
});

router.get('/media/api', canAny('settings.manage', 'website.edit'), wrap(async (req, res) => {
  const kind = LIST_KINDS.includes(req.query.kind) ? req.query.kind : '';
  const folder = typeof req.query.folder === 'string' && req.query.folder !== '' ? req.query.folder : null;
  const [items, folders] = await Promise.all([media.list(req.ctx.businessId, { q: req.query.q, folder, kind }), media.folders(req.ctx.businessId)]);
  res.set('Cache-Control', 'no-store');
  res.json({ data: items.map((m) => itemJson(req, m)), folders: folders.map((f) => f.folder) });
}));

router.get('/media/:id(\\d+)', wrap(async (req, res) => {
  const row = await media.file(req.ctx.businessId, req.params.id);
  if (!row) return res.status(404).set(FILE_HEADERS).end();
  const mime = media.sniff(row.data);
  if (!mime) return res.status(404).set(FILE_HEADERS).end();
  const filename = `${row.name}.${media.EXT[mime]}`;
  const download = req.query.download === '1';
  if (req.get('if-none-match') === `"${row.sha}"`) return res.status(304).set({ ...FILE_HEADERS, ETag: `"${row.sha}"` }).end();
  res.set({
    ...FILE_HEADERS, 'Content-Type': mime, ETag: `"${row.sha}"`, 'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  return res.send(row.data);
}));

module.exports = router;
module.exports.reasonText = reasonText;
