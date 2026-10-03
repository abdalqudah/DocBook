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
  const logo = clinic && clinic.logo_mime && clinic.slug && /^https?:\/\//.test(root) ? `${root}/${clinic.slug}/logo?v=${Number(clinic.logo_version) || 0}` : null;
  const head = logo
    ? `<img src="${esc(logo)}" alt="${esc(name)}" height="48" style="display:block;height:48px;width:auto;max-width:220px;border:0;margin-${rtl ? 'left' : 'right'}:auto">`
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

module.exports = { configured, configuredFor, send, layout };
