// Outgoing e-mail through SMTP (env), or — on a one-clinic / one-centre installation without it — the clinic's own
// verified mailbox. With neither, nothing is sent and callers show links on screen instead.
const nodemailer = require('nodemailer');
const brand = require('../config/brand');

let transport = null;
// The platform's SMTP: from the environment (SMTP_HOST…), else from Admin → Platform settings (refreshed every minute
// and when saved).
let dbSmtp = null;
let dbAt = 0;
async function refreshPlatformSmtp() {
  dbAt = Date.now();
  if (process.env.SMTP_HOST) { dbSmtp = null; return null; }
  let next = null;
  try { next = await require('../modules/platformcomms/comms.service').smtp(); } catch { next = null; } // eslint-disable-line global-require
  if (JSON.stringify(next) !== JSON.stringify(dbSmtp)) transport = null;
  dbSmtp = next;
  return dbSmtp;
}
function resetPlatformSmtp() { transport = null; dbAt = 0; refreshPlatformSmtp().catch(() => {}); }
const serverSmtp = () => Boolean(process.env.SMTP_HOST) || Boolean(dbSmtp);

// One clinic / one centre installation without the server's own SMTP: the installation's clinic mailbox (Settings →
// Clinic e-mail, verified) sends every e-mail, account e-mails included — there is no "platform address" to fall
// back on. Refreshed at start, every minute and whenever a clinic mailbox changes (see refreshInstallationMailbox).
let installationMailbox = null; // business id
let checkedAt = 0;
async function refreshInstallationMailbox() {
  checkedAt = Date.now();
  try {
    const edition = require('../config/edition'); // eslint-disable-line global-require
    if (serverSmtp() || !edition.single) { installationMailbox = null; return null; }
    const slug = await require('../middleware/edition').mainSlug(); // eslint-disable-line global-require
    const knex = require('../db/knex'); // eslint-disable-line global-require
    const b = slug ? await knex.main('businesses').where({ slug }).first('id') : null;
    const ok = b ? await require('../db/tenant').runFor(b.id, () => require('../modules/clinicmail/clinicmail.service').canSend(b.id)) : false; // eslint-disable-line global-require
    installationMailbox = ok ? b.id : null;
  } catch { installationMailbox = null; }
  return installationMailbox;
}
function configured() {
  if (Date.now() - dbAt > 60_000) refreshPlatformSmtp().catch(() => {});
  if (Date.now() - checkedAt > 60_000) refreshInstallationMailbox().catch(() => {});
  return serverSmtp() || Boolean(installationMailbox);
}
function tx() {
  if (!serverSmtp()) return null;
  if (!transport) {
    const env = Boolean(process.env.SMTP_HOST);
    const c = env ? { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : dbSmtp;
    transport = nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.port === 465,
      auth: c.user ? { user: c.user, pass: c.pass || '' } : undefined,
    });
  }
  return transport;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Branded HTML e-mail. Patient e-mails pass `clinic` (the business row) and `base` (the public address): they carry
 * the clinic's logo (or name) and colour instead of DocBook's. Arabic reads right to left — set on every block, as
 * mail apps drop the <html> attributes.
 */
// Natural size of each clinic's logo (per logo version), read once from its bytes; e-mails show it fitted in
// LOGO_BOX keeping its proportions. Until known, the logo is shown by width with an automatic height.
const LOGO_BOX = { w: 170, h: 44 };
const logoSizes = new Map();
function logoSize(clinic) {
  const key = `${clinic.id || clinic.slug}:${Number(clinic.logo_version) || 0}`;
  if (logoSizes.has(key)) return logoSizes.get(key);
  logoSizes.set(key, null);
  (async () => {
    const knex = require('../db/knex'); // eslint-disable-line global-require
    const row = await knex('businesses').where(clinic.id ? { id: clinic.id } : { slug: clinic.slug }).first('logo', 'logo_mime');
    const d = row && row.logo ? require('../modules/integrations/media.service').dimensions(row.logo, row.logo_mime) : null; // eslint-disable-line global-require
    if (d && d.width && d.height) {
      const k = Math.min(LOGO_BOX.w / d.width, LOGO_BOX.h / d.height, 1);
      logoSizes.set(key, { w: Math.max(1, Math.round(d.width * k)), h: Math.max(1, Math.round(d.height * k)) });
    }
  })().catch(() => {});
  return null;
}
/** Reads the clinic's logo size before an e-mail is built (call it before layout() when possible). */
async function warmLogo(clinic) {
  if (!clinic || !clinic.logo_mime) return;
  logoSize(clinic);
  for (let i = 0; i < 20 && logoSizes.get(`${clinic.id || clinic.slug}:${Number(clinic.logo_version) || 0}`) === null; i += 1) await new Promise((r) => { setTimeout(r, 10); }); // eslint-disable-line no-await-in-loop
}

function layout({ locale = 'en', title, body, cta, href, clinic = null, base = '' }) {
  const c = brand.colors.light;
  const rtl = locale === 'ar';
  const dir = rtl ? 'rtl' : 'ltr';
  const align = rtl ? 'right' : 'left';
  const hex = clinic && /^#[0-9a-fA-F]{6}$/.test(clinic.color || '') ? clinic.color : null;
  const primary = hex || c.primary;
  const ink = hex ? require('../modules/branding/theme').inkFor(hex) : c.primaryInk; // eslint-disable-line global-require
  const name = clinic ? ((locale === 'en' && clinic.name_en) || clinic.name) : brand.name;
  const root = String(base || '').replace(/\/+$/, '');
  const logo = clinic && clinic.logo_mime && clinic.slug && /^https?:\/\//.test(root) ? `${root}/${clinic.slug}/logo?v=${Number(clinic.logo_version) || 0}${/webp/.test(clinic.logo_mime) ? '&f=png' : ''}` : null;
  // The logo at its own proportions, fitted in a small box (a wide logo is never squeezed to a fixed height).
  const size = logo ? logoSize(clinic) : null;
  const dims = size ? `width="${size.w}" height="${size.h}" style="display:block;width:${size.w}px;height:${size.h}px;` : 'width="150" style="display:block;width:150px;max-width:150px;height:auto;';
  const head = logo
    ? `<img src="${esc(logo)}" alt="${esc(name)}" ${dims}border:0;margin-${rtl ? 'left' : 'right'}:auto">`
    : `<div style="font-weight:800;font-size:18px;color:${primary}">${esc(name)}</div>`;
  const text = esc(body).replace(/\n/g, '<br>');
  return `<!doctype html><html dir="${dir}" lang="${rtl ? 'ar' : 'en'}"><body dir="${dir}" style="margin:0;background:${c.background};font-family:Tahoma,Arial,sans-serif;color:${c.text}">
<div dir="${dir}" style="max-width:560px;margin:24px auto;background:${c.surface};border:1px solid ${c.border};border-top:4px solid ${primary};border-radius:12px;padding:28px;direction:${dir};text-align:${align}">
<div style="margin-bottom:18px;text-align:${align}">${head}</div>
<h1 dir="${dir}" style="font-size:18px;margin:0 0 12px;text-align:${align}">${esc(title)}</h1><p dir="${dir}" style="line-height:1.8;margin:0 0 20px;text-align:${align}">${text}</p>
${cta ? `<div style="text-align:${align}"><a href="${esc(href)}" style="display:inline-block;background:${primary};color:${ink};padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:700">${esc(cta)}</a></div>` : ''}
</div></body></html>`;
}

/** MAIL_FROM with another display name (same sending address), e.g. a doctor's name. */
function fromWithName(from, name) {
  if (!name) return from;
  const m = String(from).match(/<([^>]+)>/);
  return { name: String(name).replace(/[\r\n<>"]/g, ' ').trim().slice(0, 120), address: m ? m[1].trim() : String(from).trim() };
}

/**
 * Sends an e-mail. With `businessId` + `kind` (patient_letters, reminders, telehealth, suppliers), a clinic that
 * connected its own address sends from it (src/modules/clinicmail); otherwise — or if that fails — the platform
 * account sends it with the clinic's address as Reply-To. Account e-mails never pass a businessId.
 */
/** Every e-mail the platform tries to send, with how it went (Admin → E-mail log). Never fails the caller. */
function logMail(row) {
  try {
    const knex = require('../db/knex'); // eslint-disable-line global-require
    const r = { kind: String(row.kind || 'other').slice(0, 40), to_addr: String([].concat(row.to || '').join(', ')).slice(0, 255) || '—', subject: row.subject ? String(row.subject).slice(0, 255) : null,
      business_id: row.businessId || null, via: row.via, status: row.status, error: row.error ? String(row.error).slice(0, 500) : null };
    (knex.main || knex)('email_log').insert(r).catch(() => {});
  } catch { /* the log never breaks sending */ }
}

async function send(opts) {
  const meta = { kind: opts.kind, to: opts.to, subject: opts.subject, businessId: opts.businessId };
  try {
    const r = await sendRaw(opts);
    logMail({ ...meta, via: r === 'clinic' ? 'clinic' : r ? 'platform' : 'none', status: r ? 'sent' : 'not_sent', error: r ? null : 'email_not_configured' });
    return Boolean(r);
  } catch (e) {
    logMail({ ...meta, via: 'platform', status: 'failed', error: e.message });
    throw e;
  }
}

async function sendRaw({ to, subject, html, replyTo, attachments, fromName, businessId, kind }) {
  const cm = require('../modules/clinicmail/clinicmail.service'); // eslint-disable-line global-require
  const msg = { to, subject, html, replyTo, attachments, fromName };
  if (businessId && kind) {
    const r = await cm.trySend(businessId, kind, msg);
    if (r.sent) return 'clinic';
    if (r.replyTo && !replyTo) replyTo = r.replyTo; // eslint-disable-line no-param-reassign
  }
  if (Date.now() - dbAt > 60_000) await refreshPlatformSmtp();
  const t = tx();
  if (!t) {
    // No server SMTP: the clinic's own verified mailbox, else the installation's. On a one-clinic / one-centre
    // installation it is the only way out, so every e-mail uses it; on the platform a kind the clinic switched off
    // for its address (reminders, letters…) stays off.
    const single = require('../config/edition').single; // eslint-disable-line global-require
    const any = single || !cm.KINDS.includes(kind);
    if (businessId && (await cm.trySend(businessId, kind || 'account', msg, { any })).sent) return 'clinic';
    if (!installationMailbox && Date.now() - checkedAt > 5_000) await refreshInstallationMailbox();
    if (installationMailbox && installationMailbox !== businessId) {
      const id = installationMailbox;
      const r = await require('../db/tenant').runFor(id, () => cm.trySend(id, kind || 'account', msg, { any: true })); // eslint-disable-line global-require
      if (r.sent) return 'clinic';
    }
    return false;
  }
  const from = process.env.MAIL_FROM || (dbSmtp && !process.env.SMTP_HOST && dbSmtp.from) || `${brand.name} <no-reply@localhost>`;
  await t.sendMail({ from: fromWithName(from, fromName), to, subject, html, ...(replyTo ? { replyTo } : {}), ...(attachments ? { attachments } : {}) });
  return true;
}

/** Can e-mail go out for this clinic (the platform account, or the clinic's own verified account)? */
async function configuredFor(businessId) {
  if (Date.now() - dbAt > 60_000) await refreshPlatformSmtp();
  if (serverSmtp()) return true;
  if (!installationMailbox) await refreshInstallationMailbox();
  if (installationMailbox) return true;
  return businessId ? require('../modules/clinicmail/clinicmail.service').canSend(businessId) : false; // eslint-disable-line global-require
}

module.exports = { configured, configuredFor, send, layout, warmLogo, refreshInstallationMailbox, refreshPlatformSmtp, resetPlatformSmtp };
