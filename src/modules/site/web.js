// Public landing page (rendered from the editable content in content.service.js).
const express = require('express');
const { wrap } = require('../../routes/helpers');
const site = require('./content.service');

const router = express.Router();

/** Loads the header/footer content for every public page (cached for a minute) and the language picker L(). */
async function chrome(req, res, next) {
  try {
    res.locals.L = site.pick(req.locale);
    if (req.method === 'GET' && !req.path.startsWith('/app')) res.locals.siteChrome = await site.get();
    next();
  } catch (err) { next(err); }
}

router.get('/', wrap(async (req, res) => {
  const content = await site.get();
  const L = site.pick(req.locale);
  res.page('pages/site/home', {
    layout: 'public', content, pageTitle: L(content.seo && content.seo.title) || req.t('site.meta_title'),
    metaDescription: L(content.seo && content.seo.description),
  });
}));

module.exports = router;
module.exports.chrome = chrome;
