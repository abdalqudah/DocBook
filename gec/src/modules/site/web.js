// Public website routes. Content pages are added module by module (catalog, CMS, booking…).
const express = require('express');
const knex = require('../../db/knex');
const uploads = require('../../core/uploads');
const { ah, idParam } = require('../../core/http');
const settings = require('../settings/settings.service');
const events = require('../../core/events');

const router = express.Router();

// Public media (logos, CMS images). Private files (student documents) are served by their own modules.
router.get('/media/:id', ah(async (req, res) => {
  const m = await knex('media').where({ id: idParam(req.params.id), is_public: true }).first('id');
  if (!m) return res.status(404).end();
  return uploads.send(res, m.id);
}));

router.get('/', ah(async (req, res) => {
  res.page('pages/site/home', { layout: 'public', title: res.locals.branding.legal_name });
}));

router.get('/privacy', ah(async (req, res) => {
  const p = await settings.get('privacy');
  res.page('pages/site/privacy', { layout: 'public', title: req.t('privacy.title'), retention: p.retention_months });
}));

// WhatsApp entry point: one URL for every "WhatsApp us" button, so clicks can be counted (growth module) and the
// number lives in Settings → Company, not in templates.
router.get('/go/whatsapp', ah(async (req, res) => {
  const c = await settings.get('company');
  if (!c.whatsapp) return res.redirect('/');
  const text = String(req.query.text || req.t('site.whatsapp_default_text', { name: res.locals.branding.name })).slice(0, 500);
  await events.emit('site.whatsapp_click', { req, from: String(req.query.from || '').slice(0, 200) });
  return res.redirect(`https://wa.me/${c.whatsapp}?text=${encodeURIComponent(text)}`);
}));

module.exports = router;
