// The platform's help center: /help (articles by topic, search) and /help/<slug>. Mounted before the clinic pages.
const express = require('express');
const { wrap } = require('../../routes/helpers');
const help = require('./help.service');
const tpl = require('../sales/templates.service');

const router = express.Router();
router.get('/help', wrap(async (req, res, next) => {
  if (require('../../config/edition').single) return next(); // eslint-disable-line global-require
  const q = String(req.query.q || '').slice(0, 80);
  const rows = (await help.list({ q })).map((a) => ({ ...a, title: help.pick(a, req.locale).title }));
  const groups = help.CATEGORIES.map((c) => ({ key: c, rows: rows.filter((a) => a.category === c) })).filter((g) => g.rows.length);
  return res.page('pages/helpcenter/index', { layout: 'public', title: req.t('helpc.title'), groups, q });
}));
router.get('/help/:slug', wrap(async (req, res, next) => {
  if (require('../../config/edition').single) return next(); // eslint-disable-line global-require
  const a = await help.bySlug(req.params.slug);
  if (!a) return next();
  const { title, body } = help.pick(a, req.locale);
  const related = (await help.list()).filter((x) => x.category === a.category && x.id !== a.id).slice(0, 6).map((x) => ({ slug: x.slug, title: help.pick(x, req.locale).title }));
  return res.page('pages/helpcenter/article', { layout: 'public', title, a, html: tpl.render(body), related });
}));

module.exports = router;
