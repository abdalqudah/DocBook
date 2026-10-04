// Outgoing e-mail through SMTP (env). Without SMTP_HOST nothing is sent and callers show links on screen instead.
const nodemailer = require('nodemailer');
const brand = require('../config/brand');

let transport = null;
function configured() {
  return Boolean(process.env.SMTP_HOST);
}
function tx() {
  if (!configured()) return null;
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined,
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
async function send({ to, subject, html, replyTo, attachments, fromName, businessId, kind }) {
  if (businessId && kind) {
    const r = await require('../modules/clinicmail/clinicmail.service').trySend(businessId, kind, { to, subject, html, replyTo, attachments, fromName }); // eslint-disable-line global-require
    if (r.sent) return true;
    if (r.replyTo && !replyTo) replyTo = r.replyTo; // eslint-disable-line no-param-reassign
  }
  const t = tx();
  if (!t) return false;
  const from = process.env.MAIL_FROM || `${brand.name} <no-reply@localhost>`;
  await t.sendMail({ from: fromWithName(from, fromName), to, subject, html, ...(replyTo ? { replyTo } : {}), ...(attachments ? { attachments } : {}) });
  return true;
}

/** Can e-mail go out for this clinic (the platform account, or the clinic's own verified account)? */
async function configuredFor(businessId) {
  if (configured()) return true;
  return businessId ? require('../modules/clinicmail/clinicmail.service').canSend(businessId) : false; // eslint-disable-line global-require
}

module.exports = { configured, configuredFor, send, layout, warmLogo };
