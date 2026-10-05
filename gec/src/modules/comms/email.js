// E-mail channel. Providers are adapters behind one interface: generic SMTP, Google Workspace / Gmail and
// Microsoft 365 (both through their SMTP submission endpoints with an app password; OAuth can be added as another
// adapter without touching callers). Credentials come from Settings → Email (encrypted) or SMTP_* in .env.
const nodemailer = require('nodemailer');
const config = require('../../config');
const settings = require('../settings/settings.service');
const secrets = require('../../core/secrets');

const PRESETS = {
  smtp: null,
  google: { host: 'smtp.gmail.com', port: 465, encryption: 'ssl' },
  microsoft: { host: 'smtp.office365.com', port: 587, encryption: 'starttls' },
};

/** The effective e-mail configuration, or null when e-mail is not connected. */
async function currentConfig() {
  const s = await settings.get('integration.email');
  if (s && s.enabled && s.host !== undefined) {
    const preset = PRESETS[s.provider] || {};
    const pass = s.password_enc ? secrets.decrypt(s.password_enc) : '';
    return { provider: s.provider || 'smtp', host: preset.host || s.host, port: Number(preset.port || s.port || 465), encryption: preset.encryption || s.encryption || 'ssl', user: s.username || '', pass: pass || '', fromEmail: s.from_email, fromName: s.from_name || 'GEC' };
  }
  if (config.smtp.host) {
    const m = /^(.*)<([^>]+)>$/.exec(config.smtp.from || '');
    return { provider: 'env', host: config.smtp.host, port: config.smtp.port, encryption: config.smtp.port === 465 ? 'ssl' : 'starttls', user: config.smtp.user, pass: config.smtp.password, fromEmail: m ? m[2].trim() : (config.smtp.from || config.smtp.user), fromName: m ? m[1].trim().replace(/^"|"$/g, '') : 'GEC' };
  }
  return null;
}

let transportKey = null;
let transport = null;
function transportFor(c) {
  const key = JSON.stringify([c.host, c.port, c.encryption, c.user, c.pass]);
  if (key !== transportKey) {
    transport = nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.encryption === 'ssl', requireTLS: c.encryption === 'starttls',
      auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 15000, greetingTimeout: 15000,
    });
    transportKey = key;
  }
  return transport;
}

// Tests replace this with a recorder (no network).
let testOutbox = null;
const useTestOutbox = (box) => { testOutbox = box; };

/** Sends one e-mail. Resolves { sent: true, messageId } or { sent: false, reason }. Never throws for "not configured". */
async function send({ to, subject, html, text, replyTo, attachments, fromName }) {
  if (testOutbox) { testOutbox.push({ to, subject, html, text, replyTo, attachments }); return { sent: true, messageId: `test-${testOutbox.length}` }; }
  const c = await currentConfig();
  if (!c || !c.host || !c.fromEmail) return { sent: false, reason: 'not_configured' };
  const info = await transportFor(c).sendMail({
    from: { name: String(fromName || c.fromName).replace(/[\r\n<>"]/g, ' ').slice(0, 120), address: c.fromEmail },
    to, subject: String(subject).replace(/[\r\n]+/g, ' '), html, text, replyTo, attachments,
  });
  return { sent: true, messageId: info.messageId };
}

async function verify() {
  const c = await currentConfig();
  if (!c) return { ok: false, reason: 'not_configured' };
  try { await transportFor(c).verify(); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** Branded HTML e-mail (logo, brand colour, footer from Settings → Branding). `body` is plain text or safe HTML. */
async function layout({ locale = 'en', title, body, bodyHtml, cta, href }) {
  const b = await settings.get('branding');
  const rtl = locale === 'ar';
  const dir = rtl ? 'rtl' : 'ltr';
  const align = rtl ? 'right' : 'left';
  const primary = /^#[0-9a-f]{6}$/i.test(b.primary || '') ? b.primary : '#0B4D2C';
  const logo = b.email_logo_media_id ? `${config.appUrl}/media/${b.email_logo_media_id}` : `${config.appUrl}/brand/logo-horizontal.png`;
  const footer = rtl ? b.email_footer_ar : b.email_footer_en;
  const content = bodyHtml || esc(body).replace(/\n/g, '<br>');
  return `<!doctype html><html dir="${dir}" lang="${rtl ? 'ar' : 'en'}"><body dir="${dir}" style="margin:0;background:#f4f7f5;font-family:Arial,Tahoma,sans-serif;color:#111a15">
<div dir="${dir}" style="max-width:580px;margin:24px auto;background:#ffffff;border:1px solid #e1e7e3;border-radius:14px;overflow:hidden;text-align:${align}">
<div style="padding:22px 28px;border-bottom:3px solid ${primary}"><img src="${esc(logo)}" alt="${esc(b.name)}" height="40" style="height:40px;width:auto;display:block;${rtl ? 'margin-left:auto' : ''}"></div>
<div style="padding:26px 28px">${title ? `<h1 style="font-size:19px;margin:0 0 14px;color:#111a15">${esc(title)}</h1>` : ''}<div style="line-height:1.7;font-size:15px">${content}</div>
${cta && href ? `<p style="margin:22px 0 0"><a href="${esc(href)}" style="display:inline-block;background:${primary};color:#ffffff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:bold">${esc(cta)}</a></p>` : ''}</div>
<div style="padding:16px 28px;background:#f7f9f8;color:#6b776f;font-size:12px;line-height:1.6">${esc(footer)}</div></div></body></html>`;
}

module.exports = { send, verify, layout, currentConfig, useTestOutbox, PRESETS };
