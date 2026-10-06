// Staff: Settings → SEO & AI search, and Website → SEO audit.
const express = require('express');
const config = require('../../config');
const settings = require('../settings/settings.service');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah } = require('../../core/http');
const { validate, z, bool } = require('../../core/validate');
const nav = require('../staff/nav');
const svc = require('./service');

require('../settings/web').addSection({ key: 'seo', icon: 'search', href: '/staff/settings/seo', perms: ['settings.manage', 'cms.manage'] }, { after: 'privacy' });
nav.add('website', { key: 'seo_audit', href: '/staff/seo', icon: 'gauge', perms: ['cms.manage', 'settings.manage'] });

const router = express.Router();
const txt = (n) => z.preprocess((v) => (v === undefined ? '' : v), z.string().trim().max(n));
// Verification codes: the content value only (or the whole <meta> tag, from which the value is taken).
const code = () => z.preprocess((v) => { const m = /content="([^"]+)"/.exec(String(v || '')); return (m ? m[1] : String(v || '')).trim(); }, z.string().max(120).regex(/^[A-Za-z0-9_\-=.:]*$/, 'Paste the code from the verification tag.'));
const schema = z.object({
  description_en: txt(300), description_ar: txt(300), keywords_en: txt(300), keywords_ar: txt(300),
  og_image: z.preprocess((v) => String(v || '').trim(), z.string().max(500).regex(/^$|^(https:\/\/|\/)/, 'Use an https:// address or choose from the library.')),
  google_verification: code(), bing_verification: code(), yandex_verification: code(),
  ai_answers: bool(), ai_training: bool(), llms_enabled: bool(), llms_intro_en: txt(1000), llms_intro_ar: txt(1000), robots_extra: txt(3000),
});

router.get('/settings/seo', can('settings.manage', 'cms.manage'), ah(async (req, res) => {
  res.page('pages/staff/settings/seo', { layout: 'staff', narrow: true, title: req.t('settings.seo'), s: await settings.get('seo'), appUrl: config.appUrl, answerBots: svc.ANSWER_BOTS, trainingBots: svc.TRAINING_BOTS });
}));
router.post('/settings/seo', can('settings.manage', 'cms.manage'), ah(async (req, res) => {
  const d = validate(schema, req.body);
  await settings.set(req.ctx, 'seo', { ...(await settings.get('seo')), ...d });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/settings/seo');
}));

router.get('/seo', can('cms.manage', 'settings.manage'), ah(async (req, res) => {
  res.page('pages/staff/seo/audit', { layout: 'staff', title: req.t('nav.seo_audit'), a: await svc.audit(), appUrl: config.appUrl });
}));

module.exports = router;
