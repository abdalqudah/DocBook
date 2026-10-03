// Clinic e-mail (DocBook 2.0 redesign 4.11/4.12): patient-facing e-mails can go out from the clinic's own address —
// its SMTP server, or its Google / Microsoft account (send-only permission). Rules:
//   • tenant-scoped: every function takes the clinic from ctx (the session) — never from the browser;
//   • credentials are encrypted (core/secrets), write-only (never sent back to a page), never logged;
//   • the SMTP host is resolved and private / loopback addresses are refused; the connection goes to the resolved
//     address with the host name checked on TLS (no DNS re-binding onto internal services);
//   • account e-mails (sign-up, password reset, invitations, security) always use the platform account;
//   • if the clinic account fails, the e-mail still goes out from the platform with the clinic as Reply-To (logged).
const net = require('net');
const nodemailer = require('nodemailer');
const { Resolver } = require('dns').promises;
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { z, validate, optionalString } = require('../../core/validate');
const { E, AppError } = require('../../core/errors');

const KINDS = ['patient_letters', 'reminders', 'telehealth', 'suppliers'];
const PORTS = { 465: 'ssl', 587: 'starttls', 25: 'starttls', 2525: 'starttls' };
const TEST_SENDS_PER_HOUR = 5;
const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivate = (ip) => PRIVATE_V4.some((re) => re.test(ip)) || ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const cut = (s, n = 250) => String(s || '').replace(/[\r\n]+/g, ' ').slice(0, n);
// Error text without anything that could echo a credential back (the password is never in our messages anyway).
const safeError = (e) => cut(e && (e.code ? `${e.code}: ${e.response || e.message || ''}` : e.message || e), 240).replace(/(pass(word)?|auth)[^ ]*=\S+/gi, '$1=…');

// ---------------------------------------------------------------- providers (OAuth apps belong to the platform)
async function providers() {
  let google = false;
  try { google = await require('../auth/google.service').enabled(); } catch { google = false; } // eslint-disable-line global-require
  return { smtp: true, google, microsoft: Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET) };
}

// ---------------------------------------------------------------- reading
const parseUses = (v) => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.filter((k) => KINDS.includes(k)) : KINDS.slice(); } catch { return KINDS.slice(); } };
async function row(businessId) { return knex('clinic_mail_accounts').where({ business_id: businessId }).first(); }

/** What pages may show: no secret, only whether one is saved (and a masked hint of the user name). */
function publicView(r) {
  if (!r) return null;
  return {
    provider: r.provider, from_name: r.from_name, from_address: r.from_address, reply_to: r.reply_to,
    smtp_host: r.smtp_host, smtp_port: r.smtp_port, smtp_security: r.smtp_security, smtp_user: r.smtp_user, oauth_account: r.oauth_account,
    hasSecret: Boolean(r.secret_enc), uses: parseUses(r.uses), status: r.status, verified_at: r.verified_at, last_test_at: r.last_test_at, last_error: r.last_error,
  };
}
async function status(businessId) { return publicView(await row(businessId)); }
async function recentLog(businessId, limit = 20) {
  return knex('clinic_mail_log').where({ business_id: businessId }).orderBy('id', 'desc').limit(limit).select('kind', 'to_email', 'subject', 'status', 'provider', 'error', 'created_at');
}

// ---------------------------------------------------------------- saving (SMTP)
const email = () => z.string({ required_error: 'Required.' }).trim().toLowerCase().max(190).email('Enter a valid email address.');
const smtpSchema = z.object({
  from_name: optionalString(120), from_address: email(), reply_to: z.preprocess((v) => (v === '' ? undefined : v), email().optional()),
  smtp_host: z.string({ required_error: 'Required.' }).trim().toLowerCase().max(253).refine((h) => HOST_RE.test(h) && !net.isIP(h) && !/(^|\.)(localhost|local|internal|lan|home|corp|arpa)$/.test(h), 'Enter the mail server name, like smtp.yourprovider.com.'),
  smtp_port: z.preprocess((v) => Number(v), z.number().refine((p) => Boolean(PORTS[p]), 'Use port 465, 587, 25 or 2525.')),
  smtp_user: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(190),
});

/**
 * A mail server name that does not exist is often one letter-group off: "mail.doc.example.com" where the host's
 * panel says "doc.example.com" (or the other way round). When the typed name does not resolve, the nearby names
 * (without / with "mail." or "smtp.", and the sending address's domain) are tried, and the first that resolves is
 * used. Returns { host, changedFrom } — the typed host when nothing better is found (the test then says why).
 */
async function workingHost(host, fromAddress, resolver = new Resolver({ timeout: 2500, tries: 1 })) {
  const ok = async (h) => { try { return (await resolver.resolve4(h)).some((a) => !isPrivate(a)); } catch { return false; } };
  if (await ok(host)) return { host, changedFrom: null };
  const bare = host.replace(/^(mail|smtp|smtpout|email)\./, '');
  const domain = String(fromAddress || '').split('@')[1] || '';
  const tries = [...new Set([bare, `mail.${bare}`, `smtp.${bare}`, domain, domain && `mail.${domain}`].filter((h) => h && h !== host && HOST_RE.test(h)))];
  for (const h of tries) if (await ok(h)) return { host: h, changedFrom: host }; // eslint-disable-line no-await-in-loop
  return { host, changedFrom: null };
}

async function saveSmtp(ctx, input, deps = {}) {
  const d = validate(smtpSchema, input);
  let hostNote = null;
  if (!config.isTest || deps.resolver) {
    const w = await workingHost(d.smtp_host, d.from_address, deps.resolver);
    if (w.changedFrom) { hostNote = { from: w.changedFrom, to: w.host }; d.smtp_host = w.host; }
  }
  const cur = await row(ctx.businessId);
  const password = String(input.smtp_password || '');
  if (password.length > 500) throw E.validation({ smtp_password: 'Too long.' });
  // Write-only: an empty password keeps the saved one (same user name), otherwise one is required.
  // The password belongs to the mail account (user name): changing only the server name or port keeps it.
  const keep = !password && cur && cur.provider === 'smtp' && cur.secret_enc && cur.smtp_user === d.smtp_user;
  if (!password && !keep) throw E.validation({ smtp_password: 'Enter the password of this mail account.' });
  const values = {
    provider: 'smtp', from_name: d.from_name || null, from_address: d.from_address, reply_to: d.reply_to || null,
    smtp_host: d.smtp_host, smtp_port: d.smtp_port, smtp_security: PORTS[d.smtp_port], smtp_user: d.smtp_user,
    secret_enc: keep ? cur.secret_enc : secrets.encrypt(password), oauth_account: null,
    uses: JSON.stringify(usesFrom(input, cur)), status: 'pending', verified_at: null, last_error: null, updated_by: ctx.userId || null, updated_at: new Date(),
  };
  if (cur) await knex('clinic_mail_accounts').where({ business_id: ctx.businessId }).update(values);
  else await knex('clinic_mail_accounts').insert({ business_id: ctx.businessId, ...values });
  forget(ctx.businessId);
  await audit.record(ctx, 'email.connected', { entityType: 'clinic_mail', entityId: ctx.businessId, newValues: { provider: 'smtp', from: d.from_address, host: d.smtp_host, port: d.smtp_port, password_changed: !keep, host_corrected_from: hostNote ? hostNote.from : undefined } });
  const st = await status(ctx.businessId);
  return hostNote ? Object.assign(st, { hostNote }) : st;
}

const usesFrom = (input, cur) => (input.uses_field === '1' ? [].concat(input.uses || []).map(String).filter((k) => KINDS.includes(k)) : cur ? parseUses(cur.uses) : KINDS.slice());

/** Sender details and which e-mails use the clinic address (all providers). */
async function saveSender(ctx, input) {
  const cur = await row(ctx.businessId);
  if (!cur) throw E.notFound('E-mail account');
  const d = validate(z.object({ from_name: optionalString(120), reply_to: z.preprocess((v) => (v === '' ? undefined : v), email().optional()),
    from_address: cur.provider === 'smtp' ? email() : z.any().optional() }), input);
  const values = { from_name: d.from_name || null, reply_to: d.reply_to || null, uses: JSON.stringify(usesFrom({ ...input, uses_field: '1' }, cur)), updated_by: ctx.userId || null, updated_at: new Date() };
  if (cur.provider === 'smtp' && d.from_address !== cur.from_address) Object.assign(values, { from_address: d.from_address, status: 'pending', verified_at: null });
  await knex('clinic_mail_accounts').where({ business_id: ctx.businessId }).update(values);
  forget(ctx.businessId);
  await audit.record(ctx, 'email.sender_updated', { entityType: 'clinic_mail', entityId: ctx.businessId, newValues: { from_name: values.from_name, reply_to: values.reply_to, uses: JSON.parse(values.uses) } });
}

async function disconnect(ctx) {
  const cur = await row(ctx.businessId);
  if (!cur) return false;
  await knex('clinic_mail_accounts').where({ business_id: ctx.businessId }).del();
  forget(ctx.businessId);
  await audit.record(ctx, 'email.disconnected', { entityType: 'clinic_mail', entityId: ctx.businessId, oldValues: { provider: cur.provider, from: cur.from_address } });
  return true;
}

// ---------------------------------------------------------------- transports
const transports = new Map(); // businessId → { t, at }
const TRANSPORT_TTL = 10 * 60_000;
function forget(businessId) { const x = transports.get(businessId); if (x && x.t && x.t.close) x.t.close(); transports.delete(businessId); }

async function resolvePublic(host, resolver = new Resolver({ timeout: 3000, tries: 2 })) {
  let addrs = [];
  try { addrs = await resolver.resolve4(host); } catch (e) { throw new AppError('MAIL_HOST_UNKNOWN', `The mail server name could not be found (${e.code || 'DNS'}).`, 422); }
  const ip = addrs.find((a) => !isPrivate(a));
  if (!ip) throw new AppError('MAIL_HOST_PRIVATE', 'This mail server is on a private network and cannot be used.', 422);
  return ip;
}

let buildOverride = null; // tests: (row, secret) => transport
/** A nodemailer transport for the clinic account (built per clinic, reused for a few minutes). */
async function transportFor(r, { deps = {} } = {}) {
  const cached = transports.get(r.business_id);
  if (cached && Date.now() - cached.at < TRANSPORT_TTL && !deps.fresh) return cached.t;
  const secret = secrets.decrypt(r.secret_enc);
  if (!secret) throw new AppError('MAIL_SECRET_UNREADABLE', 'The saved credentials cannot be read any more. Connect the account again.', 409);
  let t;
  if (buildOverride) t = buildOverride(r, secret);
  else if (r.provider === 'smtp') {
    const ip = await resolvePublic(r.smtp_host, deps.resolver);
    t = nodemailer.createTransport({
      host: ip, port: r.smtp_port, secure: r.smtp_security === 'ssl', requireTLS: r.smtp_security === 'starttls',
      auth: { user: r.smtp_user, pass: secret }, tls: { servername: r.smtp_host, minVersion: 'TLSv1.2' },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    });
  } else {
    const oauth = require('./oauth'); // eslint-disable-line global-require
    t = nodemailer.createTransport(await oauth.transportOptions(r.provider, { user: r.oauth_account, refreshToken: secret }));
  }
  transports.set(r.business_id, { t, at: Date.now() });
  return t;
}

// ---------------------------------------------------------------- checks
/** Connects and logs in (no e-mail sent). Marks the account verified or failed. */
async function testConnection(ctx, deps = {}) {
  const r = await row(ctx.businessId);
  if (!r) throw E.notFound('E-mail account');
  forget(ctx.businessId);
  let ok = true; let error = null;
  try { await (await transportFor(r, { deps: { ...deps, fresh: true } })).verify(); } catch (e) { ok = false; error = e instanceof AppError ? e.message : safeError(e); }
  const values = { last_test_at: new Date(), last_error: error, status: ok ? 'verified' : 'failed', ...(ok ? { verified_at: r.verified_at || new Date() } : { verified_at: null }) };
  await knex('clinic_mail_accounts').where({ business_id: ctx.businessId }).update(values);
  await audit.record(ctx, 'email.tested', { entityType: 'clinic_mail', entityId: ctx.businessId, newValues: { ok, error } });
  return { ok, error };
}

/** Sends a short test e-mail to the signed-in member (a few per hour at most). */
async function testSend(ctx, to, { subject, html }) {
  const r = await row(ctx.businessId);
  if (!r) throw E.notFound('E-mail account');
  const since = new Date(Date.now() - 3600_000);
  const [{ n }] = await knex('clinic_mail_log').where({ business_id: ctx.businessId, status: 'test' }).where('created_at', '>=', since).count({ n: '*' });
  if (Number(n) >= TEST_SENDS_PER_HOUR) throw new AppError('RATE_LIMITED', 'Too many test e-mails. Try again later.', 429);
  try {
    const info = await (await transportFor(r)).sendMail({ from: { name: r.from_name || '', address: r.from_address }, to, subject, html, ...(r.reply_to ? { replyTo: r.reply_to } : {}) });
    await knex('clinic_mail_log').insert({ business_id: ctx.businessId, kind: 'test', to_email: cut(to, 190), subject: cut(subject, 190), status: 'test', provider: r.provider, message_id: cut(info && info.messageId, 190) });
    await knex('clinic_mail_accounts').where({ business_id: ctx.businessId }).update({ status: 'verified', verified_at: r.verified_at || new Date(), last_error: null, last_test_at: new Date() });
    await audit.record(ctx, 'email.test_sent', { entityType: 'clinic_mail', entityId: ctx.businessId, newValues: { to } });
    return { ok: true };
  } catch (e) {
    const error = e instanceof AppError ? e.message : safeError(e);
    await knex('clinic_mail_log').insert({ business_id: ctx.businessId, kind: 'test', to_email: cut(to, 190), subject: cut(subject, 190), status: 'failed', provider: r.provider, error });
    await knex('clinic_mail_accounts').where({ business_id: ctx.businessId }).update({ status: 'failed', last_error: error, last_test_at: new Date() });
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------- sending (called by core/mailer)
/**
 * Tries to send `msg` from the clinic's account for this kind of e-mail. → { sent: true } or { sent: false, replyTo }
 * (the caller then sends from the platform with the clinic's address as Reply-To). Never throws.
 */
async function trySend(businessId, kind, msg) {
  let r;
  try { r = await row(businessId); } catch { return { sent: false }; }
  if (!r || r.status !== 'verified' || !parseUses(r.uses).includes(kind)) return { sent: false, replyTo: r && r.status === 'verified' ? (r.reply_to || r.from_address) : null };
  // The clinic's package must include it (package changes apply at once; the platform account takes over).
  try {
    const business = await knex('businesses').where({ id: businessId }).first();
    if (!(await require('../platformops/ops.service').entitled(business, 'website.clinic_email'))) return { sent: false, replyTo: r.reply_to || r.from_address }; // eslint-disable-line global-require
  } catch { /* entitlement unknown → use the account the clinic set up */ }
  try {
    const info = await (await transportFor(r)).sendMail({
      from: { name: cut(msg.fromName || r.from_name || '', 120), address: r.from_address }, to: msg.to, subject: msg.subject, html: msg.html,
      replyTo: msg.replyTo || r.reply_to || undefined, attachments: msg.attachments,
    });
    await knex('clinic_mail_log').insert({ business_id: businessId, kind, to_email: cut(msg.to, 190), subject: cut(msg.subject, 190), status: 'sent', provider: r.provider, message_id: cut(info && info.messageId, 190) }).catch(() => {});
    return { sent: true };
  } catch (e) {
    const error = e instanceof AppError ? e.message : safeError(e);
    await knex('clinic_mail_log').insert({ business_id: businessId, kind, to_email: cut(msg.to, 190), subject: cut(msg.subject, 190), status: 'fallback', provider: r.provider, error }).catch(() => {});
    await knex('clinic_mail_accounts').where({ business_id: businessId }).update({ last_error: error }).catch(() => {});
    forget(businessId);
    return { sent: false, replyTo: r.reply_to || r.from_address };
  }
}

// ---------------------------------------------------------------- deliverability hints (SPF / DMARC / DKIM)
/** Looks up the sender domain's SPF and DMARC records (and DKIM for a given selector). Never throws. */
async function deliverability(address, selector = '', resolver = new Resolver({ timeout: 3000, tries: 1 })) {
  const domain = String(address || '').split('@')[1] || '';
  if (!HOST_RE.test(domain)) return null;
  const txt = async (name) => { try { return (await resolver.resolveTxt(name)).map((p) => p.join('')); } catch { return []; } };
  const sel = /^[a-z0-9._-]{1,63}$/i.test(selector) ? selector : '';
  const [root, dmarc, dkim] = await Promise.all([txt(domain), txt(`_dmarc.${domain}`), sel ? txt(`${sel}._domainkey.${domain}`) : Promise.resolve(null)]);
  return {
    domain, spf: root.find((v) => /^v=spf1/i.test(v)) || null, dmarc: dmarc.find((v) => /^v=DMARC1/i.test(v)) || null,
    dkim: dkim === null ? undefined : (dkim.find((v) => /p=/.test(v)) ? true : false), selector: sel || null,
  };
}

/** Can this clinic send e-mail at all (its own verified account, or the platform account)? */
async function canSend(businessId) {
  const r = await row(businessId).catch(() => null);
  return Boolean(r && r.status === 'verified');
}

module.exports = {
  KINDS, PORTS, workingHost, providers, status, deliverability, recentLog, saveSmtp, saveSender, disconnect, testConnection, testSend, trySend, canSend, forget, isPrivate, resolvePublic,
  _setBuild: (fn) => { buildOverride = fn; transports.clear(); },
  _saveOAuth: async (ctx, provider, { account, refreshToken }) => {
    const cur = await row(ctx.businessId);
    const values = { provider, from_address: account, oauth_account: account, smtp_host: null, smtp_port: null, smtp_security: null, smtp_user: null,
      secret_enc: secrets.encrypt(refreshToken), uses: JSON.stringify(cur ? parseUses(cur.uses) : KINDS.slice()), status: 'pending', verified_at: null, last_error: null, updated_by: ctx.userId || null, updated_at: new Date() };
    if (cur) await knex('clinic_mail_accounts').where({ business_id: ctx.businessId }).update({ ...values, from_name: cur.from_name, reply_to: cur.reply_to });
    else await knex('clinic_mail_accounts').insert({ business_id: ctx.businessId, ...values });
    forget(ctx.businessId);
    await audit.record(ctx, 'email.connected', { entityType: 'clinic_mail', entityId: ctx.businessId, newValues: { provider, account } });
  },
};
