// Staff: Website → Pages → Page builder (blocks) and a private preview of the page before it is published.
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah, idParam } = require('../../core/http');
const { E } = require('../../core/errors');
const { markdown } = require('../../core/markdown');
const ref = require('../catalog/reference');
const blocks = require('./blocks');
const { withData } = require('./blocks.data');

const router = express.Router();
const pageOr404 = async (id) => { const p = await knex('pages').where({ id }).first(); if (!p) throw E.notFound('Page'); return p; };

function render(req, res, p, list, extra = {}) {
  res.page('pages/staff/cms/builder', {
    layout: 'staff', title: req.t('blocks.title_for', { name: p.title_en }), p, list, types: blocks.TYPES, optionsOf: blocks.optionsOf,
    labelOf: (f, v) => (!v ? '—' : f === 'country' ? ref.countryName(v, req.locale) : f === 'degree' ? req.t(`ref.degree.${v}`) : f === 'field' ? req.t(`ref.field.${v}`) : req.t(`blocks.side.${v}`)),
    errors: {}, focus: null, ...extra,
  });
}

router.get('/pages/:id/builder', can('cms.manage'), ah(async (req, res) => {
  const p = await pageOr404(idParam(req.params.id));
  render(req, res, p, blocks.parse(p.blocks), { focus: /^\d+$/.test(req.query.focus || '') ? Number(req.query.focus) : null });
}));

router.post('/pages/:id/builder', can('cms.manage'), ah(async (req, res) => {
  const p = await pageOr404(idParam(req.params.id));
  const { blocks: list, errors, op, focus } = blocks.fromForm(req.body);
  if (Object.keys(errors).length) { res.status(422); return render(req, res, p, list, { errors }); }
  await knex('pages').where({ id: p.id }).update({ blocks: JSON.stringify(list), updated_at: new Date() });
  await audit.record(req.ctx, 'page.blocks_saved', { entityType: 'page', entityId: p.id, newValues: { blocks: list.length, op: op || 'save' } });
  if (!op) flash(req, 'ok', req.t('common.saved'));
  return res.redirect(`/staff/pages/${p.id}/builder${focus !== null ? `?focus=${focus}#b-${focus}` : ''}`);
}));

router.get('/pages/:id/preview', can('cms.manage'), ah(async (req, res) => {
  const p = await pageOr404(idParam(req.params.id));
  const faqs = await knex('faqs').where({ is_published: true, topic: p.slug }).orderBy('position');
  const pageBlocks = await withData(blocks.parse(p.blocks));
  res.page('pages/site/page', { layout: 'public', title: (req.locale === 'ar' && p.title_ar) || p.title_en, p, faqs, md: markdown, pageBlocks, heroPage: Boolean(pageBlocks[0] && pageBlocks[0].type === 'hero'), preview: true, seo: { noindex: true } });
}));

module.exports = router;
