// Settings (/staff/settings): organised sections; each module adds its own (sections.add).
const express = require('express');
const settings = require('./settings.service');
const uploads = require('../../core/uploads');
const theme = require('../branding/theme');
const { allowMultipart, flash } = require('../../middleware/web');
const { can } = require('../../middleware/auth');
const { ah } = require('../../core/http');
const { validate, z, str, reqStr, optEmail, bool, num } = require('../../core/validate');
const nav = require('../staff/nav');

nav.add('system', { key: 'settings', href: '/staff/settings', icon: 'settings', perms: ['settings.manage', 'integrations.manage', 'roles.manage'] });

// Sections of the settings index: { key, icon, href, perms }. Order = display order.
const SECTIONS = [
  { key: 'general', icon: 'settings-2', href: '/staff/settings/general', perms: ['settings.manage'] },
  { key: 'branding', icon: 'sparkles', href: '/staff/settings/branding', perms: ['settings.manage'] },
  { key: 'company', icon: 'building', href: '/staff/settings/company', perms: ['settings.manage'] },
  { key: 'roles', icon: 'shield', href: '/staff/roles', perms: ['roles.manage'] },
  { key: 'privacy', icon: 'cookie', href: '/staff/settings/privacy', perms: ['settings.manage', 'privacy.manage'] },
];
const addSection = (s, { after } = {}) => {
  if (SECTIONS.some((x) => x.key === s.key)) return;
  const i = after ? SECTIONS.findIndex((x) => x.key === after) : -1;
  if (i >= 0) SECTIONS.splice(i + 1, 0, s); else SECTIONS.push(s);
};

const router = express.Router();
const hex = () => z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #0B4D2C.');

router.get('/', ah(async (req, res) => {
  const sections = SECTIONS.filter((s) => s.perms.some((p) => req.can(p)));
  if (!sections.length) return res.redirect('/staff');
  return res.page('pages/staff/settings/index', { layout: 'staff', title: req.t('nav.settings'), sections });
}));

// ---- General
router.get('/general', can('settings.manage'), ah(async (req, res) => {
  res.page('pages/staff/settings/general', { layout: 'staff', narrow: true, title: req.t('settings.general'), general: await settings.get('general'), leads: await settings.get('leads') });
}));
router.post('/general', can('settings.manage'), ah(async (req, res) => {
  const data = validate(z.object({
    default_currency: z.string().trim().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code.'),
    timezone: reqStr(60).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Unknown time zone.'), // eslint-disable-line no-new
    assignment: z.enum(['round_robin', 'rules', 'manual']),
    first_response_hours: num(1, 240),
  }), req.body);
  await settings.patch(req.ctx, 'general', { default_currency: data.default_currency, timezone: data.timezone });
  await settings.patch(req.ctx, 'leads', { assignment: data.assignment, first_response_hours: data.first_response_hours || 24 });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/settings/general');
}));

// ---- Branding (logo, favicon, colours, e-mail footer)
const BRAND_FILES = ['logo', 'logo_white', 'favicon', 'email_logo'];
allowMultipart(/^\/staff\/settings\/branding\/upload\/?$/);
router.get('/branding', can('settings.manage'), ah(async (req, res) => {
  const b = await settings.get('branding');
  const c = (x) => theme.contrast(x, '#ffffff');
  res.page('pages/staff/settings/branding', { layout: 'staff', narrow: true, title: req.t('settings.branding'), b, contrastPrimary: c(b.primary) });
}));
router.post('/branding', can('settings.manage'), ah(async (req, res) => {
  const data = validate(z.object({
    name: reqStr(40), legal_name: reqStr(120), tagline_en: str(160), tagline_ar: str(160),
    primary: hex(), secondary: hex(), accent: hex(), email_footer_en: str(500), email_footer_ar: str(500),
  }), req.body);
  await settings.patch(req.ctx, 'branding', data);
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/settings/branding');
}));
router.post('/branding/upload', can('settings.manage'), uploads.single('file', { maxMb: 2 }), ah(async (req, res) => {
  const which = String(req.body.which || '');
  if (!BRAND_FILES.includes(which)) return res.redirect('/staff/settings/branding');
  const id = await uploads.store(req.file, { purpose: 'branding', allowed: ['png', 'webp', 'jpg'], isPublic: true, userId: req.user.id });
  const b = await settings.get('branding');
  const old = b[`${which}_media_id`];
  await settings.patch(req.ctx, 'branding', { [`${which}_media_id`]: id });
  if (old) await uploads.remove(old);
  flash(req, 'ok', req.t('common.saved'));
  return res.redirect('/staff/settings/branding');
}));
router.post('/branding/reset-file', can('settings.manage'), ah(async (req, res) => {
  const which = String(req.body.which || '');
  if (BRAND_FILES.includes(which)) {
    const b = await settings.get('branding');
    const old = b[`${which}_media_id`];
    await settings.patch(req.ctx, 'branding', { [`${which}_media_id`]: null });
    if (old) await uploads.remove(old);
  }
  res.redirect('/staff/settings/branding');
}));

// ---- Company & contact details (used in the website footer, e-mails, WhatsApp button)
router.get('/company', can('settings.manage'), ah(async (req, res) => {
  res.page('pages/staff/settings/company', { layout: 'staff', narrow: true, title: req.t('settings.company'), c: await settings.get('company') });
}));
router.post('/company', can('settings.manage'), ah(async (req, res) => {
  const url = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().url('Enter a full address starting with https://').max(255).optional());
  const data = validate(z.object({
    email: optEmail(), phone: str(40), whatsapp: z.preprocess((v) => String(v || '').replace(/\D/g, ''), z.string().max(20)),
    address_en: str(255), address_ar: str(255), website: url(),
    facebook: url(), instagram: url(), linkedin: url(), tiktok: url(), youtube: url(), x: url(),
  }), req.body);
  const { facebook, instagram, linkedin, tiktok, youtube, x, ...rest } = data;
  await settings.set(req.ctx, 'company', { ...rest, social: { facebook, instagram, linkedin, tiktok, youtube, x } });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/settings/company');
}));

// ---- Privacy (cookie consent, retention)
router.get('/privacy', can('settings.manage', 'privacy.manage'), ah(async (req, res) => {
  res.page('pages/staff/settings/privacy', { layout: 'staff', narrow: true, title: req.t('settings.privacy'), p: await settings.get('privacy') });
}));
router.post('/privacy', can('settings.manage', 'privacy.manage'), ah(async (req, res) => {
  const data = validate(z.object({ cookie_banner: bool(), analytics_requires_consent: bool(), retention_months: num(6, 120), policy_url: str(255) }), req.body);
  await settings.patch(req.ctx, 'privacy', data);
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/settings/privacy');
}));

module.exports = router;
module.exports.addSection = addSection;
module.exports.SECTIONS = SECTIONS;
