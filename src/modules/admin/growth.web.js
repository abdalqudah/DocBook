// Platform admin → landing-page media library, Search & AI (SEO/AEO/GEO) and Social & tracking.
// Mounted inside the admin router, after its platform-admin check (everyone else gets a 404).
// Every change is audited with business_id NULL by the services.
const express = require('express');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const site = require('../site/content.service');
const media = require('../site/media.service');
const seo = require('../site/seo.service');

const router = express.Router();
const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: ['/css/site.css'], ...data });

/** Validation messages here are keys in growth_err.* (site.json); unknown ones fall back to the generic text. */
function tErrors(req, err) {
  return Object.fromEntries(Object.entries(err.details || {}).map(([k, v]) => {
    const tr = req.t(String(v));
    return [k, tr !== String(v) ? tr : req.t('errors.VALIDATION_FAILED')];
  }));
}
/** Like helpers.form(): a validation error re-renders the form with the messages and what was typed. */
const formAction = (action, rerender) => wrap(async (req, res, next) => {
  try {
    await action(req, res, next);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'VALIDATION_FAILED') throw err;
    res.status(422);
    await rerender(req, res, { errors: tErrors(req, err), formError: { code: err.code, message: req.t('growth.fix_errors') }, old: req.body });
  }
});

// ---------------------------------------------------------------- media library
/** Where each image is used (sections, cards, share image) so the admin knows before deleting. */
async function usage() {
  const [content, s] = await Promise.all([site.get(), seo.get()]);
  const used = {};
  const add = (id, where) => { if (!id) return; (used[String(id)] = used[String(id)] || []).push(where); };
  content.sections.forEach((sec, i) => {
    const d = sec.design || {};
    const where = { n: i + 1, type: sec.type, id: sec.id };
    add(d.media, where); if (d.background === 'image') add(d.bg_image, where);
    for (const it of (sec.data && sec.data.items) || []) add(it.image, where);
  });
  add(s.og_image, { share: true });
  return used;
}

router.get('/site/media', wrap(async (req, res) => {
  page(res, 'site/media', { title: req.t('admin.site.media.title'), list: await media.list(), used: await usage(), pageScripts: ['/js/site-editor.js'] });
}));

// Uploads arrive as the raw file (sent by site-editor.js with the CSRF token in a header), so no multipart parser is needed.
const MB = Math.round(media.MAX_BYTES / 1048576);
const { RAW_IMAGE_MAX } = require('../../core/uploads'); // photos up to this size are accepted, then compressed
const rawImage = (req, res, next) => express.raw({ type: () => true, limit: RAW_IMAGE_MAX })(req, res, (err) => {
  if (err && err.type === 'entity.too.large') { req.uploadError = req.t('growth_err.file_too_big', { mb: MB }); return next(); }
  return next(err);
});
router.post('/site/media', rawImage, wrap(async (req, res) => {
  const wantsJson = String(req.get('accept') || '').includes('application/json');
  let error = req.uploadError || null;
  let item = null;
  if (!error) {
    try {
      let name = '';
      try { name = decodeURIComponent(String(req.get('x-file-name') || '')); } catch { name = ''; }
      const id = await media.upload(req.ctx, Buffer.isBuffer(req.body) ? req.body : null, name);
      item = (await media.map())[String(id)];
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      error = Object.values(tErrors(req, err))[0] || req.t('errors.VALIDATION_FAILED');
    }
  }
  if (error && error.includes('{mb}')) error = error.replace('{mb}', MB);
  if (wantsJson) return res.status(error ? 422 : 201).json(error ? { error } : { data: item, message: req.t('admin.site.media.uploaded') });
  flash(req, error ? 'error' : 'success', error || req.t('admin.site.media.uploaded'));
  return res.redirect('/admin/site/media');
}));

router.post('/site/media/:id(\\d+)/rename', wrap(async (req, res) => {
  await media.rename(req.ctx, req.params.id, req.body.name);
  flash(req, 'success', req.t('admin.site.media.renamed'));
  res.redirect(`/admin/site/media#m-${req.params.id}`);
}));

router.post('/site/media/:id(\\d+)/delete', wrap(async (req, res) => {
  await media.remove(req.ctx, req.params.id);
  flash(req, 'success', req.t('admin.site.media.deleted'));
  res.redirect('/admin/site/media');
}));

// ---------------------------------------------------------------- Search & AI (SEO / AEO / GEO)
const renderSeo = async (req, res, extra = {}) => {
  const [s, mkt, content, list, map] = await Promise.all([seo.get(), seo.marketing(), site.get(), media.list(), media.map()]);
  const base = seo.baseUrl(req, s);
  page(res, 'seo', {
    title: req.t('growth.seo_title'), s, images: list, AI_BOTS: seo.AI_BOTS, base, checks: await seo.checks({ s, mkt, site: content, media: map }),
    defaults: content.seo || {}, errors: {}, old: {}, pageScripts: ['/js/site-editor.js'], ...extra,
  });
};
router.get('/seo', wrap((req, res) => renderSeo(req, res)));
router.post('/seo', formAction(async (req, res) => {
  await seo.save(req.ctx, req.body);
  flash(req, 'success', req.t('growth.saved'));
  res.redirect('/admin/seo');
}, renderSeo));

// The generated llms.txt, to read or start editing from.
router.get('/seo/llms-default', wrap(async (req, res) => {
  const s = await seo.get();
  res.type('text/plain; charset=utf-8').send(await seo.llmsDefault({ s, site: await site.get(), base: seo.baseUrl(req, s) }));
}));

// Preview of the structured data the landing page carries (for checking in a validator).
router.get('/seo/structured-data', wrap(async (req, res) => {
  const [s, mkt, content] = await Promise.all([seo.get(), seo.marketing(), site.get()]);
  const base = seo.baseUrl(req, s);
  res.type('application/json; charset=utf-8').send(JSON.stringify(seo.homeLd({ s, mkt, site: content, base, locale: req.locale, description: seo.L(s.description, req.locale) || seo.L(content.seo && content.seo.description, req.locale) }), null, 2));
}));

// ---------------------------------------------------------------- Social & tracking
const renderGrowth = async (req, res, extra = {}) => {
  page(res, 'growth', { title: req.t('growth.mkt_title'), m: await seo.marketing(), SOCIAL: seo.SOCIAL, PIXELS: seo.PIXELS, errors: {}, old: {}, ...extra });
};
router.get('/growth', wrap((req, res) => renderGrowth(req, res)));
router.post('/growth', formAction(async (req, res) => {
  await seo.saveMarketing(req.ctx, req.body);
  flash(req, 'success', req.t('growth.saved'));
  res.redirect('/admin/growth');
}, renderGrowth));

module.exports = router;
