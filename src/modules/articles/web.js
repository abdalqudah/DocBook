// Articles (/app/articles): a doctor login writes and publishes its own; website editors write for any doctor or the
// clinic. Images are uploaded into the clinic's media library (folder "articles", storage limits apply).
//   GET  /                list            GET /new · /:id   editor
//   POST /                create          POST /:id         save (draft / publish / unpublish)
//   POST /:id/delete      delete          POST /images      upload images (multipart, JSON)
//   POST /preview         the body as it will look (JSON)
const express = require('express');
const uploads = require('../../core/uploads');
const knex = require('../../db/knex');
const { AppError, E } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const { wrap, flash } = require('../../routes/helpers');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const svc = require('./articles.service');
const media = require('../integrations/media.service');

const router = express.Router();
router.use((req, res, next) => (svc.rights(req.ctx).can ? next() : next(E.forbidden('articles'))));
const ASSETS = { pageScripts: ['/js/articles.js'], pageStyles: ['/css/articles.css'] };

const errText = (req, err) => {
  for (const k of [`articles.err.${err.code}`, `errors.${err.code}`]) { const s = req.t(k, err.details || {}); if (s !== k) return s; }
  return err.message;
};

router.get('/', wrap(async (req, res) => {
  const status = svc.STATUSES.includes(req.query.status) ? req.query.status : '';
  const rows = await svc.list(req.ctx, { status });
  res.page('pages/articles/index', { title: req.t('articles.title'), rows, status, rights: svc.rights(req.ctx), ...ASSETS });
}));

async function editor(req, res, a, extra = {}) {
  const authors = await svc.authorChoices(req.ctx);
  const ids = a ? [...svc.imageIds(a.body), ...svc.imageIds(a.body_en), a.cover_media_id].filter(Boolean) : [];
  const imgs = ids.length ? await knex('clinic_media').where({ business_id: req.ctx.businessId }).whereIn('id', [...new Set(ids)]).select('id', 'name', 'sha') : [];
  res.page('pages/articles/edit', {
    title: a ? (a.title || a.title_en) : req.t('articles.new'), a, authors, rights: svc.rights(req.ctx), categories: svc.CATEGORIES,
    images: imgs.map((m) => ({ id: m.id, name: m.name, url: `/app/media/${m.id}?v=${m.sha}` })), maxBytes: media.MAX_BYTES, ...ASSETS, ...extra,
  });
}
router.get('/new', wrap((req, res) => editor(req, res, null)));
router.get('/:id(\\d+)', wrap(async (req, res) => editor(req, res, await svc.get(req.ctx, req.params.id))));

const saveRoute = (getId) => wrap(async (req, res) => {
  const id = getId(req);
  try {
    const aid = await svc.save(req.ctx, id, req.body);
    const a = await svc.get(req.ctx, aid);
    const key = req.body.action === 'publish' ? (a.platform_status === 'pending' ? 'articles.published_pending' : 'articles.published') : req.body.action === 'unpublish' ? 'articles.unpublished' : 'articles.saved';
    flash(req, 'success', req.t(key));
    return res.redirect(`/app/articles/${aid}`);
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500 || err.status === 403) throw err;
    res.status(422);
    const errors = err.code === 'VALIDATION_FAILED' ? Object.fromEntries(Object.entries(err.details || {}).map(([k, v]) => [k, translateMessage(req.locale, v)])) : {};
    const before = id ? await svc.get(req.ctx, id) : null;
    const draft = { ...(before || {}), ...req.body, id: id || null, on_site: req.body.on_site === '1', on_platform: req.body.on_platform === '1', cover_media_id: Number(req.body.cover_media_id) || null };
    return editor(req, res, id || req.body.title || req.body.title_en ? draft : null, { errors, formError: { message: err.code === 'VALIDATION_FAILED' ? req.t('errors.VALIDATION_FAILED') : errText(req, err) }, old: req.body });
  }
});
router.post('/', saveRoute(() => null));
router.post('/:id(\\d+)', saveRoute((req) => Number(req.params.id)));

router.post('/:id(\\d+)/delete', wrap(async (req, res) => {
  await svc.remove(req.ctx, req.params.id);
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/articles');
}));

// The body as it will look (images through the members' address while editing).
router.post('/preview', wrap(async (req, res) => {
  const body = String((req.body && req.body.body) || '').slice(0, svc.MAX_BODY);
  const ids = svc.imageIds(body);
  const rows = ids.length ? await knex('clinic_media').where({ business_id: req.ctx.businessId }).whereIn('id', ids).select('id', 'sha', 'alt_ar', 'alt_en', 'width', 'height') : [];
  const images = Object.fromEntries(rows.map((m) => [m.id, { url: `/app/media/${m.id}?v=${m.sha}`, alt: m.alt_ar || m.alt_en || '', width: m.width, height: m.height }]));
  res.json({ html: svc.render(body, images), minutes: svc.readMinutes(body) });
}));

const upload = uploads.memory({ limits: { fileSize: media.MAX_BYTES + 1, files: 6, fields: 6, parts: 12 } }); // photos → small WebP
router.post('/images', (req, res, next) => upload.array('files', 6)(req, res, (e) => {
  if (e) req.uploadError = e.code === 'LIMIT_FILE_SIZE' ? 'MEDIA_TOO_BIG' : e.code === 'LIMIT_FILE_COUNT' ? 'MEDIA_TOO_MANY' : 'MEDIA_TYPE';
  next();
}), verifyCsrfAfterUpload, wrap(async (req, res) => {
  const saved = []; const errors = [];
  const mediaErr = (code) => { const k = `errors_integrations.${code}`; const s = req.t(k); return s !== k ? s : req.t('articles.err.UPLOAD'); };
  if (req.uploadError) errors.push(mediaErr(req.uploadError));
  for (const f of req.files || []) { // eslint-disable-line no-restricted-syntax
    try {
      const m = await media.upload(req.ctx, f, { folder: 'articles', is_public: '1' }); // eslint-disable-line no-await-in-loop
      if (!m.isImage) { await media.remove(req.ctx, m.id, { force: true }).catch(() => {}); errors.push(req.t('articles.err.NOT_IMAGE')); continue; } // eslint-disable-line no-await-in-loop, no-continue
      saved.push({ id: m.id, name: m.name, url: m.url });
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      errors.push(mediaErr(err.code));
    }
  }
  res.status(saved.length ? 200 : 422).json({ data: saved, errors });
}));

module.exports = router;
