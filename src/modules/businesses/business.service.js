// Clinics (the tenant) and their staff accounts.
// Staff sign-in management: invite by e-mail, or create the account directly with a temporary password
// (the person must choose their own password at first sign-in), generate a one-time reset link, change
// role / linked doctor profile, disable or remove access. At least one active owner always remains.
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const brand = require('../../config/brand');
const { translator } = require('../../core/i18n');
const { randomToken, sha256 } = require('../../core/tokens');
const { AppError, E } = require('../../core/errors');
const rbac = require('../rbac/rbac.service');

const PUBLIC_COLUMNS = ['id', 'name', 'name_en', 'slug', 'specialty', 'country', 'city', 'currency', 'timezone', 'about', 'about_en', 'phone', 'whatsapp', 'email',
  'address', 'map_url', 'working_hours_text', 'tax_number', 'color', 'logo_mime', 'logo_version', 'logo_square_mime', 'logo_square_version', 'booking_enabled', 'prices_on_site', 'prices_on_booking', 'calendar_color_mode', 'invoice_next_number', 'favicon_mode', 'favicon_mime', 'favicon_version',
  'onboarding_step', 'onboarding_completed_at', 'status', 'created_at', 'center_id', 'center_share_cash', 'kind',
  'online_enabled', 'online_payment_required', 'online_payment_instructions', 'online_payment_instructions_en', 'online_cancellation_policy', 'online_cancellation_policy_en'];

// ---------------------------------------------------------------- clinic portal address (/<slug>)
const RESERVED = new Set(`app admin api vendor vendors reps marketplace login logout signup verify verify-email forgot reset invite invitations workspaces theme favicon.svg favicon.ico
  css js img fonts icons.svg robots.txt sitemap.xml healthz help support docs blog about contact pricing privacy terms security book booking
  www mail static assets public uploads files auth account settings dashboard home new clinic clinics
  password preferences profile portal staff logo brand docbook demo join status kiosk queue calendar onboarding notifications review reviews hooks pay`.split(/\s+/).filter(Boolean));
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const normalizeSlug = (raw) => String(raw || '').trim().toLowerCase().replace(/\s+/g, '-');

function validateSlug(slug) {
  if (!SLUG_RE.test(slug)) return 'Use 3–40 English letters, numbers or dashes.';
  if (RESERVED.has(slug)) return 'This address is reserved. Choose another.';
  return null;
}

// Arabic → Latin letters for a readable address ("عيادة النور" → "alnoor"): no vowel marks are written in Arabic, so
// this is an approximation the clinic can change later; words like "clinic"/"centre" are dropped when more remains.
const AR = { ا: 'a', أ: 'a', إ: 'i', آ: 'a', ء: '', ؤ: 'o', ئ: 'e', ب: 'b', ت: 't', ث: 'th', ج: 'j', ح: 'h', خ: 'kh', د: 'd', ذ: 'th',
  ر: 'r', ز: 'z', س: 's', ش: 'sh', ص: 's', ض: 'd', ط: 't', ظ: 'z', ع: 'a', غ: 'gh', ف: 'f', ق: 'q', ك: 'k', ل: 'l', م: 'm', ن: 'n',
  ه: 'h', ة: 'a', ى: 'a', پ: 'p', چ: 'ch', ڤ: 'v', گ: 'g' };
const AR_FILLER = new Set(['عيادة', 'عيادات', 'مركز', 'مجمع', 'مستوصف', 'مستشفى', 'د', 'دكتور', 'الدكتور', 'الدكتورة', 'دكتورة', 'لطب', 'طب', 'للطب']);
function latinize(text) {
  const words = String(text || '').replace(/[\u064B-\u0652\u0640]/g, '').replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .split(/[\s.\-_]+/).filter(Boolean);
  const kept = words.filter((w) => !AR_FILLER.has(w));
  return (kept.length ? kept : words).map((w) => [...w].map((ch, i) => {
    if (ch === 'و') return i === 0 ? 'w' : 'oo';
    if (ch === 'ي') return i === 0 ? 'y' : 'i';
    return AR[ch] !== undefined ? AR[ch] : ch;
  }).join('').replace(/oo(?=[aeiou])/g, 'w').replace(/oo$/, 'o')).join(' ');
}

async function suggestSlug(name, trx = knex) {
  let base = normalizeSlug(latinize(name).normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/[^a-zA-Z0-9 -]/g, '')).replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!base || base.length < 3 || RESERVED.has(base)) base = `clinic-${crypto.randomBytes(2).toString('hex')}`;
  base = base.slice(0, 34);
  let slug = base; let i = 2;
  while (await trx('businesses').where({ slug }).first('id')) { slug = `${base}-${i}`; i += 1; } // eslint-disable-line no-await-in-loop
  return slug;
}

async function setSlug(ctx, raw) {
  const slug = normalizeSlug(raw);
  const error = validateSlug(slug);
  if (error) throw E.validation({ slug: error });
  const taken = await knex('businesses').where({ slug }).whereNot({ id: ctx.businessId }).first('id');
  if (taken) throw E.validation({ slug: 'Another clinic already uses this address.' });
  const before = await knex('businesses').where({ id: ctx.businessId }).first('slug');
  await knex('businesses').where({ id: ctx.businessId }).update({ slug, updated_at: new Date() });
  forget(ctx.businessId);
  cache.forgetPrefix('portal:');
  await audit.record(ctx, 'clinic.link_changed', { entityType: 'clinic', entityId: ctx.businessId, oldValues: { slug: before.slug }, newValues: { slug } });
  return slug;
}

async function bySlug(raw) {
  const slug = normalizeSlug(raw);
  if (!SLUG_RE.test(slug) || RESERVED.has(slug)) return null;
  const row = await cache.remember(`portal:${slug}`, async () => (await knex('businesses').where({ slug, status: 'active' }).first('id')) || false, 60_000);
  return row ? get(row.id) : null;
}

// ---------------------------------------------------------------- clinics
async function create(userId, { name, currency, specialty, country, city, timezone }, trx = knex) {
  const slug = await suggestSlug(name, trx);
  const [id] = await trx('businesses').insert({
    name, slug, currency: currency || 'JOD', specialty: specialty || null, country: country || null, city: city || null,
    timezone: timezone || 'Asia/Amman', created_by: userId, onboarding_step: 'clinic',
  });
  await rbac.seedRoles(id, trx);
  const owner = await rbac.getRoleByKey(id, 'owner', trx);
  await trx('memberships').insert({ business_id: id, user_id: userId, role_id: owner.id });
  await trx('users').where({ id: userId }).update({ last_business_id: id });
  await audit.record({ businessId: id, userId }, 'clinic.created', { entityType: 'clinic', entityId: id, newValues: { name, currency } }, trx);
  await require('../platformnotify/notify.service').admin('clinic_signup', { name }, { link: `/admin/clinics/${id}` }, trx); // eslint-disable-line global-require
  return id;
}

const get = (id) => cache.remember(`biz:${id}`, () => knex('businesses').where({ id }).first(PUBLIC_COLUMNS));
const forget = (id) => cache.forgetPrefix(`biz:${id}`);

async function listForUser(userId) {
  return knex('memberships as m').join('businesses as b', 'b.id', 'm.business_id').join('roles as r', 'r.id', 'm.role_id')
    .where({ 'm.user_id': userId, 'm.status': 'active' }).orderBy('b.name')
    .select('b.id', 'b.name', 'b.slug', 'b.currency', 'b.color', 'r.key as role_key', 'r.name as role_name', 'r.is_system');
}

const isMember = async (userId, businessId) => Boolean(await knex('memberships').where({ user_id: userId, business_id: businessId, status: 'active' }).first('id'));

const PROFILE_FIELDS = ['name', 'name_en', 'specialty', 'country', 'city', 'currency', 'timezone', 'about', 'about_en', 'phone', 'whatsapp', 'email', 'address',
  'map_url', 'working_hours_text', 'tax_number', 'booking_enabled', 'prices_on_site', 'prices_on_booking', 'calendar_color_mode'];

async function updateProfile(ctx, data) {
  const before = await knex('businesses').where({ id: ctx.businessId }).first(PROFILE_FIELDS);
  const patch = Object.fromEntries(Object.entries(data).filter(([k, v]) => PROFILE_FIELDS.includes(k) && v !== undefined));
  const { oldValues, newValues, changed } = audit.diff(before, patch);
  if (!changed) return;
  await knex('businesses').where({ id: ctx.businessId }).update({ ...patch, updated_at: new Date() });
  await audit.record(ctx, 'clinic.updated', { entityType: 'clinic', entityId: ctx.businessId, oldValues, newValues });
  forget(ctx.businessId);
}

async function setAppearance(ctx, { color, logo, logoMime, removeLogo, square, squareMime, removeSquare }) {
  const patch = { updated_at: new Date() };
  if (square) { patch.logo_square = square; patch.logo_square_mime = squareMime; patch.logo_square_version = knex.raw('logo_square_version + 1'); }
  if (removeSquare) { patch.logo_square = null; patch.logo_square_mime = null; patch.logo_square_version = knex.raw('logo_square_version + 1'); }
  if (color !== undefined) patch.color = color || null;
  if (logo) { patch.logo = logo; patch.logo_mime = logoMime; patch.logo_version = knex.raw('logo_version + 1'); }
  if (removeLogo) { patch.logo = null; patch.logo_mime = null; patch.logo_version = knex.raw('logo_version + 1'); }
  await knex('businesses').where({ id: ctx.businessId }).update(patch);
  await audit.record(ctx, 'clinic.appearance_updated', { entityType: 'clinic', entityId: ctx.businessId, newValues: { color: color || null, logo: logo ? 'uploaded' : removeLogo ? 'removed' : undefined, square_logo: square ? 'uploaded' : removeSquare ? 'removed' : undefined } });
  forget(ctx.businessId);
}

const logo = (id) => knex('businesses').where({ id }).first('logo', 'logo_mime', 'logo_version');
/** The square logo, else the main logo (for square places). */
async function squareLogo(id) {
  const r = await knex('businesses').where({ id }).first('logo_square', 'logo_square_mime', 'logo', 'logo_mime');
  if (!r) return null;
  if (r.logo_square) return { data: r.logo_square, mime: r.logo_square_mime };
  return r.logo ? { data: r.logo, mime: r.logo_mime } : null;
}
/** The URL of the clinic's mark for square places under `base`, or null (no logo at all). */
const markUrl = (b, base) => (b && b.logo_square_mime ? `${base}/logo-square?v=${b.logo_square_version}` : b && b.logo_mime ? `${base}/logo?v=${b.logo_version}` : null);

// ---------------------------------------------------------------- browser icon (favicon)
const FAVICON_MODES = ['platform', 'logo', 'custom'];
/**
 * The clinic's browser icon address under `base` ('/app' for the app, '/<slug>' for its public pages), or null for
 * the platform's icon. 'logo' uses the clinic logo; 'custom' an uploaded icon.
 */
function faviconPath(b, base) {
  if (!b) return null;
  if (b.favicon_mode === 'custom' && b.favicon_mime) return `${base}/favicon?v=c${b.favicon_version}`;
  if (b.favicon_mode === 'logo' && (b.logo_square_mime || b.logo_mime)) return `${base}/favicon?v=l${b.logo_version}s${b.logo_square_version || 0}`;
  return null;
}
/** The icon bytes to serve (uploaded icon or logo), or null when the clinic uses the platform's icon. */
async function faviconFile(id, { uploaded = false } = {}) {
  const r = await knex('businesses').where({ id }).first('favicon_mode', 'favicon', 'favicon_mime', 'logo', 'logo_mime', 'logo_square', 'logo_square_mime');
  if (!r) return null;
  if (uploaded) return r.favicon ? { data: r.favicon, mime: r.favicon_mime } : null; // the settings preview of the uploaded icon
  if (r.favicon_mode === 'custom' && r.favicon) return { data: r.favicon, mime: r.favicon_mime };
  if (r.favicon_mode === 'logo' && r.logo_square) return { data: r.logo_square, mime: r.logo_square_mime }; // the square logo fits a tab icon best
  if (r.favicon_mode === 'logo' && r.logo) return { data: r.logo, mime: r.logo_mime };
  return null;
}
/** Chooses the browser icon: mode, plus a new uploaded icon (buffer + checked mime) for 'custom'. Audited. */
async function setFavicon(ctx, { mode, file, mime, remove }) {
  if (!FAVICON_MODES.includes(mode)) throw E.validation({ favicon_mode: 'Choose a valid value.' });
  const before = await knex('businesses').where({ id: ctx.businessId }).first('favicon_mode', 'favicon_mime');
  const patch = { favicon_mode: mode, updated_at: new Date() };
  if (file) { patch.favicon = file; patch.favicon_mime = mime; patch.favicon_version = knex.raw('favicon_version + 1'); }
  if (remove) { patch.favicon = null; patch.favicon_mime = null; patch.favicon_version = knex.raw('favicon_version + 1'); if (mode === 'custom') patch.favicon_mode = 'platform'; }
  if (patch.favicon_mode === 'custom' && !file && !before.favicon_mime) throw E.validation({ favicon: 'Choose an icon file.' });
  await knex('businesses').where({ id: ctx.businessId }).update(patch);
  await audit.record(ctx, 'clinic.favicon_updated', { entityType: 'clinic', entityId: ctx.businessId, oldValues: { mode: before.favicon_mode }, newValues: { mode: patch.favicon_mode, icon: file ? 'uploaded' : remove ? 'removed' : undefined } });
  forget(ctx.businessId);
}

async function setOnboarding(businessId, step, done = false) {
  await knex('businesses').where({ id: businessId }).update({ onboarding_step: step, ...(done ? { onboarding_completed_at: new Date() } : {}) });
  forget(businessId);
}

/** Next invoice number for the clinic, claimed atomically inside the caller's transaction. */
async function claimInvoiceNumber(businessId, trx) {
  const row = await trx('businesses').where({ id: businessId }).forUpdate().first('invoice_next_number');
  await trx('businesses').where({ id: businessId }).update({ invoice_next_number: row.invoice_next_number + 1 });
  forget(businessId);
  return row.invoice_next_number;
}

// ---------------------------------------------------------------- staff
// Invitation / reset links: the site's real address when the caller passes it (ctx.baseUrl = publicBase(req) from
// middleware/web.js, which falls back to the opened address when APP_URL is missing or localhost), else APP_URL.
const linkBase = (ctx) => String((ctx && ctx.baseUrl) || config.appUrl).replace(/\/+$/, '');

async function listMembers(businessId) {
  return knex('memberships as m').join('users as u', 'u.id', 'm.user_id').join('roles as r', 'r.id', 'm.role_id')
    .leftJoin('doctors as d', 'd.id', 'm.doctor_id')
    .where('m.business_id', businessId)
    .select('m.id', 'm.user_id', 'm.status', 'm.role_id', 'm.doctor_id', 'm.job_title', 'm.created_at', 'u.name', 'u.email', 'u.phone', 'd.phone as doctor_phone', 'd.whatsapp as doctor_whatsapp', 'u.last_login_at', 'u.must_change_password',
      'r.key as role_key', 'r.name as role_name', 'r.is_system', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en')
    .orderBy('u.name');
}

async function ownerCount(businessId, trx = knex) {
  const [{ n }] = await trx('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.business_id': businessId, 'r.key': 'owner', 'm.status': 'active' }).count({ n: '*' });
  return Number(n);
}

async function resolveRole(ctx, roleId, trx = knex) {
  const role = await trx('roles').where({ id: roleId, business_id: ctx.businessId }).first();
  if (!role) throw E.validation({ role_id: 'Choose a valid role.' });
  // Only an owner hands out the owner role, and a custom role with permissions the actor lacks (a manager cannot
  // promote anyone — or a second account of their own — above themselves). Built-in roles keep their usual use.
  if (role.key === 'owner' && ctx.roleKey !== 'owner') throw E.forbidden('owner');
  if (ctx.roleKey !== 'owner') {
    // Only an owner appoints a clinic manager (a manager could otherwise make a second, unrestricted manager account
    // and step around page blocks the owner set); any other role — built-in or custom — must be within the actor's
    // own access.
    if (role.key === 'clinic_manager') throw E.forbidden('owner');
    const perms = typeof role.permissions === 'string' ? JSON.parse(role.permissions || '[]') : (role.permissions || []);
    rbac.checkGrantable(ctx, perms);
  }
  return role;
}

async function resolveDoctor(ctx, role, doctorId, trx = knex) {
  if (!doctorId) {
    if (role.key === 'doctor') throw E.validation({ doctor_id: 'Link this account to a doctor profile.' });
    return null;
  }
  const d = await trx('doctors').where({ id: doctorId, business_id: ctx.businessId }).first('id');
  if (!d) throw E.validation({ doctor_id: 'Choose a valid value.' });
  const taken = await trx('memberships').where({ business_id: ctx.businessId, doctor_id: doctorId }).first('id', 'user_id');
  return { id: d.id, takenBy: taken };
}

async function changeMember(ctx, membershipId, { roleId, status, doctorId, jobTitle }) {
  const m = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.id': membershipId, 'm.business_id': ctx.businessId }).first('m.*', 'r.key as role_key');
  if (!m) throw E.notFound('Staff member');
  // Nobody but an owner changes their own access or an owner's account.
  if (ctx.roleKey !== 'owner' && (m.user_id === ctx.userId || m.role_key === 'owner')) throw E.forbidden('owner');
  // Nor anyone with more access than the person changing them (a custom role beyond theirs, a clinic manager).
  if (ctx.roleKey !== 'owner') {
    const theirs = await rbac.getUserPermissions(ctx.businessId, m.user_id);
    const mine = ctx.permissions instanceof Set ? ctx.permissions : new Set(ctx.permissions || []);
    if (m.role_key === 'clinic_manager' || [...theirs].some((p) => !mine.has(p))) throw E.forbidden('above');
  }
  const role = roleId ? await resolveRole(ctx, roleId) : await knex('roles').where({ id: m.role_id }).first();
  const losingOwner = m.role_key === 'owner' && (role.key !== 'owner' || status === 'disabled');
  if (losingOwner && (await ownerCount(ctx.businessId)) <= 1) throw E.conflict('LAST_OWNER', 'A clinic must keep at least one active owner.');
  if (m.user_id === ctx.userId && status === 'disabled') throw E.conflict('SELF_DISABLE', 'You cannot disable your own access.');
  const patch = { role_id: role.id, updated_at: new Date() };
  if (status) patch.status = status;
  if (jobTitle !== undefined) patch.job_title = jobTitle || null;
  if (doctorId !== undefined || role.key === 'doctor') {
    const doc = await resolveDoctor(ctx, role, doctorId === undefined ? m.doctor_id : doctorId);
    if (doc && doc.takenBy && doc.takenBy.id !== m.id) throw E.validation({ doctor_id: 'Another account is already linked to this doctor.' });
    patch.doctor_id = doc ? doc.id : null;
  }
  await knex('memberships').where({ id: membershipId }).update(patch);
  await audit.record(ctx, 'staff.updated', { entityType: 'staff', entityId: m.user_id, oldValues: { role: m.role_key, status: m.status, doctor_id: m.doctor_id }, newValues: { role: role.key, status: patch.status, doctor_id: patch.doctor_id } });
  rbac.invalidate(ctx.businessId);
}

async function removeMember(ctx, membershipId) {
  const m = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.id': membershipId, 'm.business_id': ctx.businessId }).first('m.*', 'r.key as role_key');
  if (!m) throw E.notFound('Staff member');
  if (m.user_id === ctx.userId) throw E.conflict('SELF_REMOVE', 'You cannot remove yourself.');
  if (m.role_key === 'owner' && ctx.roleKey !== 'owner') throw E.forbidden('owner');
  if (m.role_key === 'owner' && (await ownerCount(ctx.businessId)) <= 1) throw E.conflict('LAST_OWNER', 'A clinic must keep at least one active owner.');
  await knex('memberships').where({ id: membershipId }).del();
  await audit.record(ctx, 'staff.removed', { entityType: 'staff', entityId: m.user_id });
  rbac.invalidate(ctx.businessId);
}

/** A readable temporary password (shown once to the admin; the person must replace it at first sign-in). */
const tempPassword = () => `${crypto.randomBytes(3).toString('hex')}-${crypto.randomBytes(3).toString('hex')}-${crypto.randomInt(10, 99)}`;

/**
 * Adds a staff member.
 *  mode 'invite'   → an invitation link (e-mailed when SMTP is configured; always returned to share by hand)
 *  mode 'password' → the account is created now with a temporary password returned to the admin
 * An existing account (same e-mail) always gets an invitation it must accept (never attached or reset by the clinic).
 */
async function addStaff(ctx, { name, email, phone, roleId, doctorId, jobTitle, mode, locale }) {
  const role = await resolveRole(ctx, roleId);
  const doc = await resolveDoctor(ctx, role, doctorId);
  if (doc && doc.takenBy) throw E.validation({ doctor_id: 'Another account is already linked to this doctor.' });
  const existing = await knex('users').where({ email }).first('id');
  if (existing && await knex('memberships').where({ business_id: ctx.businessId, user_id: existing.id }).first('id')) {
    throw E.conflict('ALREADY_MEMBER', 'This person is already a staff member.');
  }
  // An account that already exists is never attached (nor given a password) by another clinic: it receives an
  // invitation and joins only when its owner signs in and accepts. The answer is the same as for a new address,
  // so the form does not tell which e-mails have accounts.
  if (mode === 'password' && !existing) {
    const password = tempPassword();
    const { hashPassword } = require('../auth/auth.service'); // eslint-disable-line global-require
    const userId = await knex.transaction(async (trx) => {
      const [id] = await trx('users').insert({ name, email, phone: phone || null, password_hash: await hashPassword(password), must_change_password: true, locale: locale || 'ar', last_business_id: ctx.businessId });
      await trx('memberships').insert({ business_id: ctx.businessId, user_id: id, role_id: role.id, doctor_id: doc ? doc.id : null, job_title: jobTitle || null });
      await audit.record(ctx, 'staff.created', { entityType: 'staff', entityId: id, newValues: { email, role: role.key, temporary_password: true } }, trx);
      return id;
    });
    rbac.invalidate(ctx.businessId);
    return { created: true, userId, password };
  }
  const token = randomToken(32);
  await knex('invitations').insert({ business_id: ctx.businessId, email, name: name || null, role_id: role.id, doctor_id: doc ? doc.id : null, token_hash: sha256(token), invited_by: ctx.userId, expires_at: new Date(Date.now() + 7 * 86400_000) });
  const link = `${linkBase(ctx)}/invite/${token}`;
  const clinic = await get(ctx.businessId);
  const t = translator(locale || 'ar');
  const sent = await mailer.send({
    to: email, subject: `${brand.name} — ${t('team.invite_mail_subject', { clinic: clinic.name, business: clinic.name })}`,
    html: mailer.layout({ locale, title: t('team.invite_mail_subject', { clinic: clinic.name, business: clinic.name }), body: t('team.invite_mail_body', { clinic: clinic.name, business: clinic.name, role: role.is_system ? t(`roles.${role.key}`) : role.name, name: name || email }), cta: t('team.invite_mail_cta'), href: link }),
  }).catch(() => false);
  await audit.record(ctx, 'staff.invited', { entityType: 'invitation', entityId: email, newValues: { email, role: role.key } });
  return { link, sent };
}

/**
 * One-time password reset link created by a clinic admin (for clinics without e-mail).
 * Only for accounts that belong to this clinic alone — otherwise the link is e-mailed to the person instead.
 */
async function adminResetLink(ctx, membershipId) {
  const m = await knex('memberships').where({ id: membershipId, business_id: ctx.businessId }).first();
  if (!m) throw E.notFound('Staff member');
  const [{ n }] = await knex('memberships').where({ user_id: m.user_id }).whereNot({ business_id: ctx.businessId }).count({ n: '*' });
  const user = await knex('users').where({ id: m.user_id }).first();
  // A platform admin or a supplier's account is never reset by a clinic: the link only goes to its own e-mail.
  // Nor is the account of someone with more access than the person asking (an owner, or permissions they lack):
  // that would let a manager sign in as the owner.
  let above = false;
  const tr = await knex('roles').where({ id: m.role_id, business_id: ctx.businessId }).first('key');
  if (tr && tr.key === 'owner' && m.user_id !== ctx.userId) above = true; // another owner: the link only reaches them by e-mail
  if (ctx.roleKey !== 'owner') {
    const r = await knex('roles').where({ id: m.role_id, business_id: ctx.businessId }).first('key');
    const theirs = await rbac.getUserPermissions(ctx.businessId, m.user_id);
    const mine = ctx.permissions instanceof Set ? ctx.permissions : new Set(ctx.permissions || []);
    above = (r && r.key === 'owner') || [...theirs].some((p) => !mine.has(p));
  }
  const guarded = above || Boolean(user.is_platform_admin) || Boolean(await knex('vendor_users').where({ user_id: user.id }).first('user_id').catch(() => null));
  const token = randomToken(32);
  await knex('password_resets').insert({ user_id: user.id, token_hash: sha256(token), created_by: ctx.userId, expires_at: new Date(Date.now() + 24 * 3600_000) });
  const link = `${linkBase(ctx)}/reset/${token}`;
  if (Number(n) > 0 || guarded) {
    // The account also belongs to another clinic (or is an admin / supplier account): only the person may receive
    // the link, by e-mail.
    if (!mailer.configured()) {
      await knex('password_resets').where({ user_id: user.id, token_hash: sha256(token) }).del();
      throw E.conflict('RESET_NEEDS_EMAIL', 'This person also works at another clinic. A reset link can only be e-mailed to them, and e-mail is not configured.');
    }
    const t = translator(user.locale || 'ar');
    await mailer.send({ to: user.email, subject: `${brand.name} — ${t('auth.reset_mail_subject')}`, html: mailer.layout({ locale: user.locale, title: t('auth.reset_mail_subject'), body: t('auth.reset_mail_body', { minutes: 24 * 60 }), cta: t('auth.reset_mail_cta'), href: link }) }).catch(() => {});
    await audit.record(ctx, 'staff.reset_link_created', { entityType: 'staff', entityId: user.id, newValues: { delivery: 'email' } });
    return { emailed: true, email: user.email, name: user.name };
  }
  await audit.record(ctx, 'staff.reset_link_created', { entityType: 'staff', entityId: user.id, newValues: { delivery: 'link' } });
  return { link, email: user.email, name: user.name };
}

async function listInvitations(businessId) {
  return knex('invitations as i').join('roles as r', 'r.id', 'i.role_id').leftJoin('doctors as d', 'd.id', 'i.doctor_id').where('i.business_id', businessId)
    .whereNull('i.accepted_at').whereNull('i.revoked_at').where('i.expires_at', '>', new Date())
    .leftJoin('users as ib', 'ib.id', 'i.invited_by').orderBy('i.created_at', 'desc')
    .select('i.id', 'i.email', 'i.name', 'i.expires_at', 'i.created_at', 'r.key as role_key', 'r.name as role_name', 'r.is_system', 'd.full_name as doctor_name', 'ib.name as invited_by_name');
}

async function revokeInvitation(ctx, id) {
  const n = await knex('invitations').where({ id, business_id: ctx.businessId }).whereNull('accepted_at').update({ revoked_at: new Date() });
  if (!n) throw E.notFound('Invitation');
  await audit.record(ctx, 'staff.invitation_revoked', { entityType: 'invitation', entityId: id });
}

const findInvitation = (token) => knex('invitations as i').join('businesses as b', 'b.id', 'i.business_id').join('roles as r', 'r.id', 'i.role_id')
  .where('i.token_hash', sha256(String(token || ''))).whereNull('i.accepted_at').whereNull('i.revoked_at').where('i.expires_at', '>', new Date())
  .first('i.*', 'b.name as business_name', 'b.slug as business_slug', 'r.key as role_key');

async function acceptInvitation(inv, userId, trx = knex) {
  const exists = await trx('memberships').where({ business_id: inv.business_id, user_id: userId }).first();
  if (!exists) {
    const docFree = inv.doctor_id && !(await trx('memberships').where({ business_id: inv.business_id, doctor_id: inv.doctor_id }).first('id'));
    await trx('memberships').insert({ business_id: inv.business_id, user_id: userId, role_id: inv.role_id, doctor_id: docFree ? inv.doctor_id : null });
  }
  await trx('invitations').where({ id: inv.id }).update({ accepted_at: new Date() });
  await trx('users').where({ id: userId }).update({ last_business_id: inv.business_id });
  await audit.record({ businessId: inv.business_id, userId }, 'staff.joined', { entityType: 'staff', entityId: userId }, trx);
  rbac.invalidate(inv.business_id);
}

/** Deletes a whole clinic. Requires typing its exact name and the data.manage permission (checked by the route). */
async function destroy(ctx, confirmName) {
  const b = await knex('businesses').where({ id: ctx.businessId }).first('name');
  if (!b || String(confirmName || '').trim() !== b.name) throw E.validation({ confirm_name: 'Type the clinic name exactly to confirm.' });
  await audit.record(ctx, 'clinic.deleted', { entityType: 'clinic', entityId: ctx.businessId, oldValues: { name: b.name } });
  await knex.transaction(async (trx) => {
    // Rows that reference roles without ON DELETE CASCADE go first, then everything else cascades from the clinic.
    await trx('invitations').where({ business_id: ctx.businessId }).del();
    await trx('memberships').where({ business_id: ctx.businessId }).del();
    await trx('users').where({ last_business_id: ctx.businessId }).update({ last_business_id: null });
    await trx('businesses').where({ id: ctx.businessId }).del();
  });
  rbac.invalidate(ctx.businessId);
  cache.forgetPrefix('portal:');
  forget(ctx.businessId);
}

/**
 * Whether the clinic may change this member's name, e-mail and phone: not their own (My account), not an account that
 * also belongs to another clinic, a platform admin or a supplier, and never someone with more access than the person
 * asking (a manager changing the owner's e-mail could then reset the owner's password). Another owner's e-mail stays
 * theirs to change. Returns { ok, reason, user, member }.
 */
async function memberDetailsAccess(ctx, membershipId) {
  const m = await knex('memberships').where({ id: membershipId, business_id: ctx.businessId }).first();
  if (!m) throw E.notFound('Staff member');
  const user = await knex('users').where({ id: m.user_id }).first();
  if (m.user_id === ctx.userId) return { ok: false, reason: 'self', user, member: m };
  const [{ n }] = await knex('memberships').where({ user_id: m.user_id }).whereNot({ business_id: ctx.businessId }).count({ n: '*' });
  const vendor = await knex('vendor_users').where({ user_id: user.id }).first('user_id').catch(() => null);
  if (Number(n) > 0 || user.is_platform_admin || vendor) return { ok: false, reason: 'shared', user, member: m };
  const r = await knex('roles').where({ id: m.role_id, business_id: ctx.businessId }).first('key');
  const targetOwner = Boolean(r && r.key === 'owner');
  if (targetOwner) return { ok: false, reason: 'owner', user, member: m }; // another owner keeps their own details
  if (ctx.roleKey !== 'owner') {
    const theirs = await rbac.getUserPermissions(ctx.businessId, m.user_id);
    const mine = ctx.permissions instanceof Set ? ctx.permissions : new Set(ctx.permissions || []);
    if (targetOwner || [...theirs].some((p) => !mine.has(p))) return { ok: false, reason: 'above', user, member: m };
  }
  return { ok: true, emailLocked: targetOwner, user, member: m };
}

/** Changes a member's name, e-mail and phone (see memberDetailsAccess). A new e-mail must be free; it is unverified
 *  until the person confirms it, and the old address is told of the change. Audited. */
async function changeMemberDetails(ctx, membershipId, { name, email, phone }) {
  const a = await memberDetailsAccess(ctx, membershipId);
  if (!a.ok) throw new AppError('MEMBER_DETAILS_LOCKED', 'This person changes these details from their own account.', 403, { reason: a.reason });
  const u = a.user;
  const values = {};
  if (name && name !== u.name) values.name = name;
  if ((phone || null) !== (u.phone || null)) values.phone = phone || null;
  const newEmail = email ? String(email).trim().toLowerCase() : null;
  if (newEmail && newEmail !== String(u.email).toLowerCase()) {
    if (a.emailLocked) throw E.validation({ email: 'Another owner changes their e-mail from their own account.' });
    const taken = await knex('users').whereRaw('LOWER(email) = ?', [newEmail]).whereNot({ id: u.id }).first('id');
    if (taken) throw E.validation({ email: 'This e-mail is already used by another account.' });
    values.email = newEmail;
    values.email_verified_at = null;
  }
  if (!Object.keys(values).length) return { changed: false };
  await knex('users').where({ id: u.id }).update({ ...values, updated_at: new Date() });
  await audit.record(ctx, 'staff.details_changed', { entityType: 'staff', entityId: u.id,
    oldValues: { name: u.name, email: u.email, phone: u.phone }, newValues: { name: values.name, email: values.email, phone: values.phone } });
  if (values.email && mailer.configured()) {
    const t = translator(u.locale || 'ar');
    await mailer.send({ to: u.email, subject: `${brand.name} — ${t('team.email_changed_subject')}`, html: mailer.layout({ locale: u.locale, title: t('team.email_changed_subject'), body: t('team.email_changed_body', { email: values.email }) }) }).catch(() => {});
  }
  return { changed: true, emailChanged: Boolean(values.email) };
}

// ---------------------------------------------------------------- sending a member their sign-in details
// Passwords are stored hashed, so "sign-in details" are: the clinic's sign-in address, the person's username (their
// e-mail) and a one-time link to set their own password (valid 72 hours). By e-mail: always to the person's own
// address. By WhatsApp: a ready message to the person's own number that the clinic sends from its phone — only for
// members the clinic may manage fully (memberDetailsAccess): never an account shared with another clinic or someone
// with more access, whose link must only reach them by e-mail.
const LOGIN_LINK_HOURS = 72;

function memberPhone(user, doctor) {
  return (user && user.phone) || (doctor && (doctor.whatsapp || doctor.phone)) || null;
}

async function loginDetailsFor(ctx, membershipId) {
  const a = await memberDetailsAccess(ctx, membershipId);
  if (a.reason === 'self') throw E.validation({ member: 'Use My account for your own sign-in.' });
  const doctor = a.member.doctor_id ? await knex('doctors').where({ id: a.member.doctor_id, business_id: ctx.businessId }).first('phone', 'whatsapp').catch(() => null) : null;
  const biz = await knex('businesses').where({ id: ctx.businessId }).first('name', 'name_en', 'slug', 'country', 'timezone', 'kind', 'center_id');
  return { ...a, phone: memberPhone(a.user, doctor), biz, whatsappAllowed: a.ok };
}

function loginMessage(t, { clinic, signIn, email, link }) {
  return [t('team.login_msg_hello', { clinic }), '', `${t('team.login_msg_signin')}: ${signIn}`, `${t('team.login_msg_user')}: ${email}`, '',
    t('team.login_msg_set', { hours: LOGIN_LINK_HOURS }), link].join('\n');
}

/** Sends (e-mail) or prepares (WhatsApp: returns the wa.me address) a member's sign-in details. Audited. */
async function sendLoginDetails(ctx, membershipId, channel) {
  const d = await loginDetailsFor(ctx, membershipId);
  const u = d.user;
  if (channel === 'whatsapp' && !d.whatsappAllowed) throw new AppError('LOGIN_DETAILS_EMAIL_ONLY', 'This person\'s sign-in link can only be e-mailed to them.', 403);
  if (channel === 'email' && !(await mailer.configuredFor(ctx.businessId))) throw E.conflict('EMAIL_NOT_CONFIGURED', 'E-mail is not set up yet.');
  let to = null;
  if (channel === 'whatsapp') {
    const ch = require('../messaging/channels'); // eslint-disable-line global-require
    const countries = require('../telehealth/countries'); // eslint-disable-line global-require
    const options = require('../settings/options'); // eslint-disable-line global-require
    to = ch.msisdn(d.phone, countries.dialOf(d.biz.country) || countries.dialOf(options.countryForZone(d.biz.timezone)));
    if (!to) throw E.validation({ phone: 'Add this person\'s mobile number first (Edit member).' });
  }
  const token = randomToken(32);
  await knex('password_resets').insert({ user_id: u.id, token_hash: sha256(token), created_by: ctx.userId, expires_at: new Date(Date.now() + LOGIN_LINK_HOURS * 3600_000) });
  const base = linkBase(ctx);
  // the clinic's staff sign-in: /login for the installation's own clinic (one clinic / one centre), else /<address>/login
  const signIn = d.biz.slug ? `${require('../../config/edition').siteUrl(base, d.biz).replace(/\/+$/, '')}/login` : `${base}/login`; // eslint-disable-line global-require
  const link = `${base}/reset/${token}`;
  // WhatsApp is written by the person sending it (their language); an e-mail is in the member's own language.
  const lang = channel === 'whatsapp' ? (ctx.locale || u.locale || 'ar') : (u.locale || 'ar');
  const t = translator(lang);
  const clinic = (lang === 'en' && d.biz.name_en) || d.biz.name;
  const text = loginMessage(t, { clinic, signIn, email: u.email, link });
  await audit.record(ctx, 'staff.login_details_sent', { entityType: 'staff', entityId: u.id, newValues: { channel } });
  if (channel === 'email') {
    const body = [t('team.login_msg_hello', { clinic }), `${t('team.login_msg_signin')}: ${signIn}`, `${t('team.login_msg_user')}: ${u.email}`, t('team.login_msg_set', { hours: LOGIN_LINK_HOURS })].join('\n');
    // A shared or higher account (another clinic, the platform, a supplier, more access): its link never passes
    // through this clinic's own mailbox (whose server or Sent folder the clinic controls) — the system's mail only.
    const via = d.whatsappAllowed ? { businessId: ctx.businessId, kind: 'team' } : {};
    const sent = await mailer.send({ to: u.email, ...via, subject: `${clinic} — ${t('team.login_mail_subject')}`, html: mailer.layout({ locale: lang, title: t('team.login_mail_subject'), body, cta: t('team.login_mail_cta'), href: link }) }).then((ok) => ok !== false).catch(() => false);
    if (!sent) throw E.conflict('EMAIL_FAILED', 'The e-mail could not be sent. Check the e-mail settings.');
    return { channel, name: u.name, email: u.email };
  }
  const ch = require('../messaging/channels'); // eslint-disable-line global-require
  return { channel, name: u.name, href: ch.waMeLink(to, text) };
}

/** E-mails every active member (or one group of roles) their sign-in details, except the person sending. */
async function emailLoginDetailsToAll(ctx, { roleKeys = null } = {}) {
  if (!(await mailer.configuredFor(ctx.businessId))) throw E.conflict('EMAIL_NOT_CONFIGURED', 'E-mail is not set up yet.');
  const q = knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.business_id': ctx.businessId, 'm.status': 'active' }).whereNot('m.user_id', ctx.userId);
  if (roleKeys && roleKeys.length) q.whereIn('r.key', roleKeys);
  const rows = await q.select('m.id');
  const out = { sent: 0, failed: 0 };
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    try { await sendLoginDetails(ctx, r.id, 'email'); out.sent += 1; } catch { out.failed += 1; } // eslint-disable-line no-await-in-loop
  }
  return out;
}

module.exports = {
  create, get, forget, listForUser, isMember, updateProfile, setAppearance, logo, squareLogo, markUrl, setOnboarding, claimInvoiceNumber, FAVICON_MODES, faviconPath, faviconFile, setFavicon,
  setSlug, bySlug, validateSlug, normalizeSlug, suggestSlug, latinize, RESERVED,
  listMembers, changeMember, changeMemberDetails, memberDetailsAccess, sendLoginDetails, emailLoginDetailsToAll, loginDetailsFor, memberPhone, removeMember, addStaff, adminResetLink, listInvitations, revokeInvitation, findInvitation, acceptInvitation, destroy, AppError,
};
