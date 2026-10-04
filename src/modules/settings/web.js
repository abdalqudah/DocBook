// Settings: clinic profile, clinic page & online booking, appearance, roles, clinical lists, personal account & security.
// Staff & logins live in team.web.js, data & audit in data.web.js.
const express = require('express');
const multer = require('multer');
const uploads = require('../../core/uploads');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const { z, validate, optionalString, emptyToUndefined, password } = require('../../core/validate');
const { E, AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const images = require('../../core/images');
const businesses = require('../businesses/business.service');
const { PORTAL_ROLES } = require('../rbac/permissions');
const clinical = require('../clinic/clinical.service');
const authService = require('../auth/auth.service');
const security = require('../auth/security.service');
const options = require('./options');
const { form, message } = require('./form');
const { translator } = require('../../core/i18n');
const { render, sectionsFor, baseUrl } = require('./common');
const domains = require('../branding/domain.service');
const google = require('../auth/google.service');
const { errorText: identityError, appHostRedirect } = require('../auth/google.web');

const router = express.Router();
const back = (req, fallback) => {
  const r = String(req.body._return || '');
  return r.startsWith('/app/') && !r.startsWith('//') ? r : fallback;
};

// ---------------------------------------------------------------- overview
router.get('/', wrap(async (req, res) => {
  const b = req.business;
  const [members, doctors] = await Promise.all([
    req.ctx.permissions.has('users.manage') ? knex('memberships').where({ business_id: b.id }).count({ n: '*' }).then((r) => Number(r[0].n)) : null,
    knex('doctors').where({ business_id: b.id, is_active: true }).count({ n: '*' }).then((r) => Number(r[0].n)),
  ]);
  render(req, res, 'index', 'overview', { title: req.t('settings.title'), groups: sectionsFor(req.ctx.permissions, req.ctx.modules), stats: { members, doctors }, publicUrl: b.slug ? require('../../config/edition').siteUrl(baseUrl(req), b) : null });
}));

// ---------------------------------------------------------------- clinic profile
const phone = () => z.preprocess(emptyToUndefined, z.string().trim().max(40).regex(/^[+0-9\s()-]{6,40}$/, 'Enter a valid phone number.').optional());
const httpsUrl = () => z.preprocess(emptyToUndefined, z.string().trim().max(500).url('Enter a valid URL.').refine((v) => /^https:\/\//i.test(v), 'Use an https:// URL.').optional());
const profileSchema = z.object({
  name: z.string().trim().min(2, 'Enter the clinic name.').max(160),
  name_en: optionalString(160),
  specialty: z.preprocess(emptyToUndefined, z.string().refine((v) => require('../platformops/clinic-types').valid(v), 'Choose a valid value.').optional()),
  about: optionalString(5000), about_en: optionalString(5000),
  phone: phone(), whatsapp: phone(),
  email: z.preprocess(emptyToUndefined, z.string().trim().toLowerCase().email('Enter a valid email address.').max(190).optional()),
  address: optionalString(500), map_url: httpsUrl(), working_hours_text: optionalString(500), tax_number: optionalString(60),
  city: optionalString(100),
  country: z.preprocess(emptyToUndefined, z.enum(options.COUNTRIES, { errorMap: () => ({ message: 'Choose a valid value.' }) }).optional()),
  currency: z.enum(options.CURRENCIES, { errorMap: () => ({ message: 'Choose a currency.' }) }),
  timezone: z.enum(options.ZONE_IDS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
});
const nullify = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v]));

const renderClinic = async (req, res, extra = {}) => {
  const [{ n }] = await knex('invoices').where({ business_id: req.ctx.businessId }).count({ n: '*' });
  render(req, res, 'clinic', 'clinic', {
    b: req.business, hasInvoices: Number(n) > 0,
    specialtyOptions: require('../platformops/clinic-types').options(req.t, req.business && req.business.specialty), // eslint-disable-line global-require
    currencyOptions: options.currencyOptions(req.t), zoneOptions: options.zoneOptions(req.locale), countryOptions: options.countryOptions(req.locale), ...extra,
  });
};
router.get('/clinic', can('settings.manage'), wrap((req, res) => renderClinic(req, res)));
router.post('/clinic', can('settings.manage'), form(async (req, res) => {
  const d = nullify(validate(profileSchema, req.body));
  await businesses.updateProfile(req.ctx, d);
  flash(req, 'success', req.t('settings.saved'));
  res.redirect('/app/settings/clinic');
}, renderClinic));

// ---------------------------------------------------------------- clinic page & online booking
const renderPortal = async (req, res, extra = {}) => {
  const b = req.business;
  const [doctors, services, onlineDoctors] = await Promise.all([
    knex('doctors').where({ business_id: b.id, is_active: true }).count({ n: '*' }).then((r) => Number(r[0].n)),
    knex('services').where({ business_id: b.id, is_active: true }).count({ n: '*' }).then((r) => Number(r[0].n)),
    knex('doctors').where({ business_id: b.id, is_active: true, online_enabled: true }).count({ n: '*' }).then((r) => Number(r[0].n)), // online consultations
  ]);
  render(req, res, 'portal', 'portal', {
    onlineDoctors,
    b, base: baseUrl(req), publicUrl: b.slug ? require('../../config/edition').siteUrl(baseUrl(req), b) : null, suggestion: b.slug ? null : await businesses.suggestSlug(b.name_en || b.name),
    portalRoles: PORTAL_ROLES, readiness: { doctors, services }, ...await domainData(req), ...extra,
  });
};
router.get('/portal', can('settings.manage'), wrap((req, res) => renderPortal(req, res)));
router.get('/portal/check', canAny('website.edit', 'settings.manage'), wrap(async (req, res) => {
  const slug = businesses.normalizeSlug(req.query.slug);
  let error = businesses.validateSlug(slug);
  if (!error) {
    const taken = await knex('businesses').where({ slug }).whereNot({ id: req.ctx.businessId }).first('id');
    if (taken) error = 'Another clinic already uses this address.';
  }
  res.json({ ok: !error, slug, url: `${baseUrl(req)}/${slug}`, error: error ? message(req.locale, error) : null, current: slug === req.business.slug });
}));
router.post('/portal/slug', canAny('website.edit', 'settings.manage'), form(async (req, res) => {
  await businesses.setSlug(req.ctx, req.body.slug);
  flash(req, 'success', req.t('settings.portal_saved'));
  res.redirect('/app/website/settings');
}, renderPortal));
// ---------------------------------------------------------------- custom domain for the clinic page
async function domainData(req) {
  const d = await domains.forClinic(req.ctx.businessId);
  return { domain: d, domainRecords: domains.records(d), platformHost: domains.platformHost() };
}
router.post('/portal/domain', canAny('website.domain', 'settings.manage'), form(async (req, res) => {
  await domains.save(req.ctx, req.body.host);
  flash(req, 'success', req.t('identity.domain_saved'));
  res.redirect('/app/website/domain');
}, (req, res, extra) => renderPortal(req, res, { ...extra, formError: null, domainErrors: extra.errors, domainFormError: extra.formError && extra.formError.code !== 'VALIDATION_FAILED' ? { ...extra.formError, message: identityError(req, extra.formError) } : null, errors: {} })));
router.post('/portal/domain/verify', canAny('website.domain', 'settings.manage'), form(async (req, res) => {
  const r = await domains.check(req.ctx, req.ctx.businessId);
  if (r.justVerified) flash(req, 'success', req.t('identity.domain_now_live'));
  else if (r.live) flash(req, r.owned ? 'success' : 'warning', req.t(r.owned ? 'identity.domain_still_live' : 'identity.domain_keep_txt'));
  else if (r.conflict) flash(req, 'error', req.t('errors_identity.DOMAIN_TAKEN'));
  else flash(req, 'warning', req.t(!r.owned ? 'identity.domain_missing_txt' : 'identity.domain_missing_cname'));
  res.redirect('/app/website/domain');
}, (req, res, extra) => renderPortal(req, res, { ...extra, formError: null, domainFormError: extra.formError ? { ...extra.formError, message: identityError(req, extra.formError) } : null })));
router.post('/portal/domain/delete', canAny('website.domain', 'settings.manage'), form(async (req, res) => {
  await domains.remove(req.ctx);
  flash(req, 'success', req.t('identity.domain_removed'));
  res.redirect('/app/website/domain');
}, (req, res, extra) => renderPortal(req, res, { ...extra, formError: null, domainFormError: extra.formError ? { ...extra.formError, message: identityError(req, extra.formError) } : null })));
router.post('/portal/booking', canAny('website.edit', 'settings.manage'), wrap(async (req, res) => {
  const on = req.body.booking_enabled === '1';
  await businesses.updateProfile(req.ctx, { booking_enabled: on });
  flash(req, 'success', on ? req.t('settings.booking_on_done') : req.t('settings.booking_off_done'));
  res.redirect('/app/website/booking');
}));

// ---------------------------------------------------------------- appearance (personal display + clinic branding)
const HEX = /^#[0-9a-fA-F]{6}$/;
const renderAppearance = (req, res, extra = {}) => render(req, res, 'appearance', 'appearance', { b: req.business, logoError: extra.logoError || null, ...extra });
router.get('/appearance', wrap((req, res) => renderAppearance(req, res)));
router.post('/appearance', can('settings.manage'), form(async (req, res) => {
  const d = validate(z.object({
    color: z.preprocess(emptyToUndefined, z.string().trim().regex(HEX, 'Choose a valid colour.').optional()),
    calendar_color_mode: z.enum(['status', 'doctor']).optional(),
    reset_color: z.string().optional(),
  }), req.body);
  await businesses.setAppearance(req.ctx, { color: d.reset_color ? null : (d.color ? d.color.toLowerCase() : null) });
  if (d.calendar_color_mode) await businesses.updateProfile(req.ctx, { calendar_color_mode: d.calendar_color_mode });
  flash(req, 'success', req.t('settings.saved'));
  res.redirect('/app/settings/appearance');
}, renderAppearance));

const LOGO_TYPES = { 'image/png': (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' };
const upload = uploads.memory({ limits: { fileSize: 1024 * 1024, files: 1, fields: 5 }, maxSide: 1200 }); // logos → small WebP
const logoUpload = (req, res, next) => upload.single('logo')(req, res, (err) => {
  if (err) { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'logo_too_big' : 'logo_invalid'; }
  next();
});
router.post('/appearance/logo', can('settings.manage'), logoUpload, verifyCsrfAfterUpload, wrap(async (req, res) => {
  const f = req.file;
  let problem = req.uploadError || (!f ? 'logo_missing' : null);
  if (!problem && (!LOGO_TYPES[f.mimetype] || !LOGO_TYPES[f.mimetype](f.buffer))) problem = 'logo_invalid';
  if (problem) { flash(req, 'error', req.t(`settings.${problem}`)); return res.redirect('/app/settings/appearance'); }
  await businesses.setAppearance(req.ctx, { logo: f.buffer, logoMime: f.mimetype });
  flash(req, 'success', req.t('settings.logo_saved'));
  return res.redirect('/app/settings/appearance');
}));
// Square logo: for square places (booking summary, the public pages' badge, the browser icon).
const squareUpload = (req, res, next) => upload.single('logo_square')(req, res, (err) => {
  if (err) { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'logo_too_big' : 'logo_invalid'; }
  next();
});
router.post('/appearance/logo-square', can('settings.manage'), squareUpload, verifyCsrfAfterUpload, wrap(async (req, res) => {
  const f = req.file;
  let problem = req.uploadError || (!f ? 'logo_missing' : null);
  if (!problem && (!LOGO_TYPES[f.mimetype] || !LOGO_TYPES[f.mimetype](f.buffer))) problem = 'logo_invalid';
  if (problem) { flash(req, 'error', req.t(`settings.${problem}`)); return res.redirect('/app/settings/appearance#square-logo'); }
  await businesses.setAppearance(req.ctx, { square: f.buffer, squareMime: f.mimetype });
  flash(req, 'success', req.t('settings.logo_saved'));
  return res.redirect('/app/settings/appearance#square-logo');
}));
router.post('/appearance/logo-square/delete', can('settings.manage'), wrap(async (req, res) => {
  await businesses.setAppearance(req.ctx, { removeSquare: true });
  flash(req, 'success', req.t('settings.logo_removed'));
  res.redirect('/app/settings/appearance#square-logo');
}));
router.post('/appearance/logo/delete', can('settings.manage'), wrap(async (req, res) => {
  await businesses.setAppearance(req.ctx, { removeLogo: true });
  flash(req, 'success', req.t('settings.logo_removed'));
  res.redirect('/app/settings/appearance');
}));

// Browser icon: the platform's, the clinic logo, or an uploaded icon (PNG / ICO / WebP / JPEG, up to 256 KB).
const iconUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024, files: 1, fields: 5 } });
router.post('/appearance/favicon', can('settings.manage'), (req, res, next) => iconUpload.single('favicon')(req, res, (err) => {
  if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'favicon_too_big' : 'favicon_invalid';
  next();
}), verifyCsrfAfterUpload, wrap(async (req, res) => {
  const f = req.file;
  const mode = businesses.FAVICON_MODES.includes(req.body.favicon_mode) ? req.body.favicon_mode : 'platform';
  let mime = null;
  if (req.uploadError) { flash(req, 'error', req.t(`settings.${req.uploadError}`)); return res.redirect('/app/settings/appearance#favicon'); }
  if (f) {
    mime = images.sniff(f.buffer, images.ICON_TYPES);
    if (!mime) { flash(req, 'error', req.t('settings.favicon_invalid')); return res.redirect('/app/settings/appearance#favicon'); }
  }
  try {
    await businesses.setFavicon(req.ctx, { mode: f ? 'custom' : mode, file: f ? f.buffer : null, mime, remove: req.body.remove === '1' });
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    flash(req, 'error', req.t('settings.favicon_missing')); return res.redirect('/app/settings/appearance#favicon');
  }
  flash(req, 'success', req.t('settings.favicon_saved'));
  return res.redirect('/app/settings/appearance#favicon');
}));

// ---------------------------------------------------------------- personal account & preferences
const renderAccount = async (req, res, extra = {}) => {
  const memberships = await businesses.listForUser(req.user.id);
  const mem = await myMembership(req);
  render(req, res, 'account', 'account', { me: req.user, memberships, myOwnPhoto: Boolean(mem && mem.photo_media_id), myDoctor: Boolean(mem && mem.doctor_id), ...extra });
};
router.get('/account', wrap((req, res) => renderAccount(req, res)));

// My photo: uploaded into the clinic's media library (folder "team"); a doctor's account also becomes the doctor's photo
// on the website, booking page and staff screens. Removing it leaves the file in the library.
const media = require('../integrations/media.service');
const photoUpload = uploads.memory({ limits: { fileSize: media.MAX_BYTES + 1, files: 1, fields: 5 }, maxSide: 900 });
const myMembership = (req) => knex('memberships').where({ business_id: req.ctx.businessId, user_id: req.user.id }).first('id', 'doctor_id', 'photo_media_id');
router.post('/account/photo', (req, res, next) => photoUpload.single('photo')(req, res, (e) => {
  if (e) req.uploadError = e.code === 'LIMIT_FILE_SIZE' ? 'MEDIA_TOO_BIG' : 'MEDIA_TYPE';
  next();
}), verifyCsrfAfterUpload, wrap(async (req, res) => {
  const mem = await myMembership(req);
  if (!mem) throw E.notFound('Membership');
  const fail = (code) => { const k = `errors_integrations.${code}`; const t = req.t(k); flash(req, 'error', t !== k ? t : req.t('settings.photo_invalid')); return res.redirect('/app/settings/account'); };
  if (req.uploadError) return fail(req.uploadError);
  if (!req.file) return fail('photo_missing');
  let m;
  try {
    m = await media.upload(req.ctx, req.file, { folder: 'team', is_public: mem.doctor_id ? '1' : '0', name: req.user.name });
  } catch (err) { if (!(err instanceof AppError) || err.status >= 500) throw err; return fail(err.code); }
  if (!m.isImage) { await media.remove(req.ctx, m.id, { force: true }).catch(() => {}); return fail('MEDIA_TYPE'); }
  await knex('memberships').where({ id: mem.id }).update({ photo_media_id: m.id, updated_at: new Date() });
  await knex('media_usages').where({ business_id: req.ctx.businessId, context: 'member.photo', ref_id: mem.id }).del();
  await knex('media_usages').insert({ business_id: req.ctx.businessId, media_id: m.id, context: 'member.photo', ref_id: mem.id, sort_order: 0 });
  if (mem.doctor_id) await media.setDoctorPhoto(req.ctx, mem.doctor_id, m.id);
  require('../../core/cache').forgetPrefix(`media:me:${req.ctx.businessId}:`); // eslint-disable-line global-require
  await audit.record(req.ctx, 'user.photo_updated', { entityType: 'user', entityId: req.user.id, oldValues: { photo_media_id: mem.photo_media_id || null }, newValues: { photo_media_id: m.id, doctor_id: mem.doctor_id || null } });
  flash(req, 'success', req.t(mem.doctor_id ? 'settings.photo_saved_doctor' : 'settings.photo_saved'));
  return res.redirect('/app/settings/account');
}));
router.post('/account/photo/delete', wrap(async (req, res) => {
  const mem = await myMembership(req);
  if (!mem) throw E.notFound('Membership');
  if (mem.photo_media_id) {
    await knex('memberships').where({ id: mem.id }).update({ photo_media_id: null, updated_at: new Date() });
    await knex('media_usages').where({ business_id: req.ctx.businessId, context: 'member.photo', ref_id: mem.id }).del();
    if (mem.doctor_id) {
      const d = await knex('doctors').where({ business_id: req.ctx.businessId, id: mem.doctor_id }).first('photo_media_id');
      if (d && d.photo_media_id === mem.photo_media_id) await media.setDoctorPhoto(req.ctx, mem.doctor_id, null);
    }
    require('../../core/cache').forgetPrefix(`media:me:${req.ctx.businessId}:`); // eslint-disable-line global-require
    await audit.record(req.ctx, 'user.photo_removed', { entityType: 'user', entityId: req.user.id, oldValues: { photo_media_id: mem.photo_media_id } });
  }
  flash(req, 'success', req.t('settings.photo_removed'));
  res.redirect('/app/settings/account');
}));

function applyPreferences(res, { locale, theme }) {
  const cookie = { maxAge: 365 * 86_400_000, sameSite: 'lax', secure: config.isProd };
  if (locale) res.cookie('db_lang', locale, { ...cookie, httpOnly: true });
  if (theme === 'system') res.clearCookie('db_theme');
  else if (theme) res.cookie('db_theme', theme, cookie); // read by the theme toggle too
}

router.post('/account', form(async (req, res) => {
  const d = validate(z.object({
    name: z.string().trim().min(2, 'Enter your full name.').max(160),
    phone: phone(),
    locale: z.enum(['ar', 'en']),
    theme: z.enum(['system', 'light', 'dark']),
  }), req.body);
  const before = await knex('users').where({ id: req.user.id }).first('name', 'phone', 'locale', 'theme');
  const patch = { name: d.name, phone: d.phone || null, locale: d.locale, theme: d.theme };
  const { oldValues, newValues, changed } = audit.diff(before, patch);
  if (changed) {
    await knex('users').where({ id: req.user.id }).update({ ...patch, updated_at: new Date() });
    await audit.record(req.ctx, 'user.profile_updated', { entityType: 'user', entityId: req.user.id, oldValues, newValues });
  }
  applyPreferences(res, d);
  flash(req, 'success', translator(d.locale)('settings.saved'));
  res.redirect(back(req, '/app/settings/account'));
}, renderAccount));

router.post('/preferences', form(async (req, res) => {
  const d = validate(z.object({ locale: z.enum(['ar', 'en']).optional(), theme: z.enum(['system', 'light', 'dark']).optional() }), req.body);
  const patch = Object.fromEntries(Object.entries(d).filter(([, v]) => v));
  if (Object.keys(patch).length) {
    await knex('users').where({ id: req.user.id }).update({ ...patch, updated_at: new Date() });
    await audit.record(req.ctx, 'user.preferences_updated', { entityType: 'user', entityId: req.user.id, newValues: patch });
  }
  applyPreferences(res, d);
  flash(req, 'success', req.t('settings.saved'));
  res.redirect(back(req, '/app/settings/appearance'));
}, renderAppearance));

// ---------------------------------------------------------------- security: password & sessions
const renderSecurity = async (req, res, extra = {}) => {
  const sessions = (await security.listSessions(req.user.id)).map((s) => ({ ...s, current: s.sid === req.sessionID }))
    .sort((a, b) => (b.current - a.current) || String(b.since || '').localeCompare(String(a.since || '')));
  const recent = await knex('audit_logs').where({ user_id: req.user.id }).whereIn('action', ['auth.login', 'auth.login_failed', 'auth.password_changed', 'auth.password_reset', 'auth.temporary_password_replaced', 'auth.google_linked', 'auth.google_unlinked', 'auth.google_login_failed'])
    .orderBy('id', 'desc').limit(8).select('action', 'ip', 'user_agent', 'created_at');
  const g = await google.settings();
  const ok = req.session.googleLinkOk;
  const googleLinkReady = Boolean(ok && ok.userId === req.user.id && Date.now() - ok.at < 5 * 60_000);
  render(req, res, 'security', 'security', { me: req.user, sessions, recent, googleAvailable: g.enabled && !req.user.is_platform_admin, googleLinkReady, ...extra });
};
router.get('/security', wrap((req, res) => renderSecurity(req, res)));
router.post('/security/password', form(async (req, res) => {
  const d = validate(z.object({ current_password: z.string().min(1, 'Password is required.'), new_password: password(), new_password_confirm: z.string() }), req.body);
  if (d.new_password !== d.new_password_confirm) throw E.validation({ new_password_confirm: 'Passwords do not match.' });
  await authService.changePassword(req.ctx, { currentPassword: d.current_password, newPassword: d.new_password });
  flash(req, 'success', req.t('settings.password_changed'));
  res.redirect('/app/settings/security');
}, renderSecurity));
// Link a Google account: confirm the password first (a borrowed session cannot add a way back in), then Google.
router.post('/security/google/link', form(async (req, res) => {
  if (!(await google.enabled())) throw new AppError('GOOGLE_OFF', 'Google sign-in is not available.', 404);
  if (req.user.is_platform_admin) throw new AppError('GOOGLE_NOT_ALLOWED', 'Platform admin accounts sign in with their password only.', 403);
  if (appHostRedirect(req)) throw new AppError('GOOGLE_HOST', 'Open DocBook at its main address to link Google.', 409);
  const d = validate(z.object({ google_password: z.string().min(1, 'Password is required.') }), req.body);
  const user = await knex('users').where({ id: req.user.id }).first();
  if (!(await authService.verifyPassword(user, d.google_password))) {
    await audit.record(req.ctx, 'auth.login_failed', { entityType: 'user', entityId: req.user.id, newValues: { reason: 'google_link_password' } });
    throw E.validation({ google_password: 'Current password is incorrect.' });
  }
  // The form's CSP (form-action 'self') forbids redirecting a form post to Google, so the page offers a link next.
  req.session.googleLinkOk = { userId: req.user.id, at: Date.now() };
  res.redirect('/app/settings/security#google');
}, (req, res, extra) => renderSecurity(req, res, {
  ...extra, formError: null, errors: {}, openDialog: 'google-link-dialog',
  googleErrors: extra.errors,
  googleFormError: extra.formError && extra.formError.code !== 'VALIDATION_FAILED' ? { ...extra.formError, message: identityError(req, extra.formError) } : null,
})));
router.post('/security/google/unlink', wrap(async (req, res) => {
  if (await google.unlink(req.ctx, req.user.id)) flash(req, 'success', req.t('identity.google_unlinked_done'));
  res.redirect('/app/settings/security');
}));
router.post('/security/sessions/revoke', wrap(async (req, res) => {
  const sid = String(req.body.sid || '');
  if (!sid || sid === req.sessionID) throw E.validation({ sid: 'Choose a valid value.' });
  await security.endSession(req.user.id, sid);
  await audit.record(req.ctx, 'auth.session_ended', { entityType: 'user', entityId: req.user.id });
  flash(req, 'success', req.t('settings.session_revoked'));
  res.redirect('/app/settings/security');
}));
router.post('/security/sessions/revoke-others', wrap(async (req, res) => {
  const n = await security.endOtherSessions(req.user.id, req.sessionID);
  await audit.record(req.ctx, 'auth.other_sessions_ended', { entityType: 'user', entityId: req.user.id, newValues: { count: n } });
  flash(req, 'success', req.t('settings.sessions_revoked', { n }));
  res.redirect('/app/settings/security');
}));

// ---------------------------------------------------------------- insurance providers
const renderInsurance = async (req, res, extra = {}) => {
  const rows = await knex('insurance_providers').where({ business_id: req.ctx.businessId }).orderBy([{ column: 'is_active', order: 'desc' }, { column: 'sort_order' }, { column: 'name' }]);
  const used = await knex('patients').where({ business_id: req.ctx.businessId }).whereNotNull('insurance_provider_id').groupBy('insurance_provider_id').select('insurance_provider_id').count({ n: '*' });
  render(req, res, 'insurance', 'insurance', { rows, used: Object.fromEntries(used.map((u) => [u.insurance_provider_id, Number(u.n)])), ...extra });
};
const rerenderIns = (req, res, extra) => renderInsurance(req, res, { ...extra, openDialog: 'insurance-dialog', formAction: req.originalUrl });
router.get('/insurance', can('settings.manage'), wrap((req, res) => renderInsurance(req, res)));
router.post('/insurance', can('settings.manage'), form(async (req, res) => {
  await clinical.saveInsurance(req.ctx, null, req.body);
  flash(req, 'success', req.t('settings.insurance_saved'));
  res.redirect('/app/settings/insurance');
}, rerenderIns));
router.post('/insurance/:id(\\d+)', can('settings.manage'), form(async (req, res) => {
  await clinical.saveInsurance(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect('/app/settings/insurance');
}, rerenderIns));
router.post('/insurance/:id(\\d+)/delete', can('settings.manage'), wrap(async (req, res) => {
  await clinical.insurance.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/settings/insurance');
}));

// ---------------------------------------------------------------- medications list
const medsGate = canAny('settings.manage', 'prescriptions.create');
const renderMeds = async (req, res, extra = {}) => {
  const { rows, meta } = await clinical.medications.list(req.ctx, req.query, { perPage: 50 });
  const [{ n }] = await knex('medications').where({ business_id: req.ctx.businessId }).count({ n: '*' });
  render(req, res, 'medications', 'medications', { rows, meta, totalAll: Number(n), ...extra });
};
const rerenderMed = (req, res, extra) => renderMeds(req, res, { ...extra, openDialog: 'med-dialog', formAction: req.originalUrl });
router.get('/medications', medsGate, wrap((req, res) => renderMeds(req, res)));
router.post('/medications', medsGate, form(async (req, res) => {
  await clinical.saveMedication(req.ctx, null, req.body);
  flash(req, 'success', req.t('settings.med_saved'));
  res.redirect(back(req, '/app/settings/medications'));
}, rerenderMed));
router.post('/medications/starter', medsGate, wrap(async (req, res) => {
  await clinical.seedMedications(req.ctx.businessId);
  await audit.record(req.ctx, 'medication.starter_list_added', { entityType: 'medication' });
  flash(req, 'success', req.t('settings.med_starter_done'));
  res.redirect('/app/settings/medications');
}));
router.post('/medications/:id(\\d+)', medsGate, form(async (req, res) => {
  await clinical.saveMedication(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(back(req, '/app/settings/medications'));
}, rerenderMed));
router.post('/medications/:id(\\d+)/delete', medsGate, wrap(async (req, res) => {
  await clinical.medications.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(back(req, '/app/settings/medications'));
}));

router.use('/team', require('./team.web')); // old address: GET redirects to /app/clinic/team (src/routes/app.js); posts still work
router.use('/roles', require('./roles.web'));
router.use('/data', require('./data.web'));

module.exports = router;
