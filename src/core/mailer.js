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

/** Minimal branded HTML e-mail (colours from the brand config). */
function layout({ locale = 'en', title, body, cta, href }) {
  const c = brand.colors.light;
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html dir="${dir}"><body style="margin:0;background:${c.background};font-family:Arial,Tahoma,sans-serif;color:${c.text}">
<div style="max-width:560px;margin:24px auto;background:${c.surface};border:1px solid ${c.border};border-radius:12px;padding:28px">
<div style="font-weight:800;font-size:18px;color:${c.primary};margin-bottom:18px">${esc(brand.name)}</div>
<h1 style="font-size:18px;margin:0 0 12px">${esc(title)}</h1><p style="line-height:1.7;margin:0 0 20px">${esc(body)}</p>
${cta ? `<a href="${esc(href)}" style="display:inline-block;background:${c.primary};color:${c.primaryInk};padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:700">${esc(cta)}</a>` : ''}
</div></body></html>`;
}

async function send({ to, subject, html, replyTo, attachments }) {
  const t = tx();
  if (!t) return false;
  await t.sendMail({ from: process.env.MAIL_FROM || `${brand.name} <no-reply@localhost>`, to, subject, html, ...(replyTo ? { replyTo } : {}), ...(attachments ? { attachments } : {}) });
  return true;
}

module.exports = { configured, send, layout };
