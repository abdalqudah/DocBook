// Outgoing message channels. No channel pretends to send: each one returns { ok, id?, error? } from the real
// provider answer, and callers record that in message_log.
//  • WhatsApp Cloud API (Meta Graph API): POST https://graph.facebook.com/<version>/<phone-number-id>/messages
//    with an approved TEMPLATE message (business-initiated messages outside the 24-hour window must be templates).
//  • SMS through a generic HTTP provider: URL + method + body template with {to} and {text} placeholders and one
//    optional auth header (works with Unifonic, Twilio-style and most local gateways).
//  • e-mail through src/core/mailer (SMTP from the environment).
// `transport.fetch` can be replaced in tests (no real network call).
const mailer = require('../../core/mailer');

const defaultFetch = (...args) => globalThis.fetch(...args);
const transport = { fetch: defaultFetch };
const GRAPH_VERSION = () => process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- phone numbers
/**
 * International number as digits only (what WhatsApp and most SMS gateways expect), or null.
 * "+962 79 123 4567", "00962791234567", "0791234567" (with dial 962) and "791234567" (with dial 962) all give "962791234567".
 */
function msisdn(phone, dial) {
  let raw = String(phone || '').trim().replace(/[\s().\-/]/g, '');
  if (!raw) return null;
  let intl = false;
  if (raw.startsWith('+')) { raw = raw.slice(1); intl = true; } else if (raw.startsWith('00')) { raw = raw.slice(2); intl = true; }
  if (!/^\d+$/.test(raw)) return null;
  const code = String(dial || '').replace(/\D/g, '');
  if (!intl) {
    if (raw.startsWith('0')) {
      if (!code) return null;
      raw = code + raw.replace(/^0+/, '');
    } else if (code && raw.length <= 10 && !raw.startsWith(code)) raw = code + raw;
  }
  return /^[1-9]\d{7,14}$/.test(raw) ? raw : null;
}

/** "+962 ••• ••67" — enough for staff to recognise a number in the log without exposing it. */
function maskPhone(digits) {
  const d = String(digits || '');
  if (d.length < 6) return '••••';
  return `+${d.slice(0, 3)}••••${d.slice(-2)}`;
}
function maskEmail(email) {
  const [u, h] = String(email || '').split('@');
  if (!h) return '••••';
  return `${u.slice(0, 1)}•••@${h}`;
}

async function call(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await transport.fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 240);

// ---------------------------------------------------------------- WhatsApp Cloud API
/**
 * Template message body for the Graph API.
 * @param {{ to, template, language, body: string[], urlSuffix?: string, quickPayload?: string }} m
 *   body         values of {{1}}, {{2}}… in the template body (in order)
 *   urlSuffix    value of the dynamic URL button ({{1}} at the end of the button URL)
 *   quickPayload payload of a quick-reply button placed BEFORE the URL button (index 0)
 */
function waTemplatePayload({ to, template, language, body = [], urlSuffix, quickPayload }) {
  const components = [];
  if (body.length) components.push({ type: 'body', parameters: body.map((text) => ({ type: 'text', text: String(text).slice(0, 1000) })) });
  let index = 0;
  if (quickPayload) { components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: quickPayload }] }); index += 1; }
  if (urlSuffix) components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: urlSuffix }] });
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template: { name: template, language: { code: language }, components } };
}

async function sendWhatsApp({ phoneNumberId, token }, payload) {
  if (!phoneNumberId || !token) return { ok: false, error: 'not_configured' };
  try {
    const res = await call(`https://graph.facebook.com/${GRAPH_VERSION()}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    const id = data && Array.isArray(data.messages) && data.messages[0] && data.messages[0].id;
    if (res.ok && id) return { ok: true, id: String(id).slice(0, 120) };
    const e = data && data.error;
    return { ok: false, error: short(e ? `${e.code || res.status}: ${e.error_user_msg || e.message || ''}` : `HTTP ${res.status}`) };
  } catch (err) {
    return { ok: false, error: short(err.name === 'AbortError' ? 'timeout' : err.message) };
  }
}

// ---------------------------------------------------------------- generic HTTP SMS
const jsonEscape = (s) => JSON.stringify(String(s)).slice(1, -1);

/** Fills {to} and {text} in the body template, escaped for the content type (JSON string / form value). */
function smsBody(template, contentType, to, text) {
  const tpl = String(template || '');
  if (/json/i.test(contentType)) return tpl.replace(/\{to\}/g, jsonEscape(to)).replace(/\{text\}/g, jsonEscape(text));
  if (/x-www-form-urlencoded/i.test(contentType)) return tpl.replace(/\{to\}/g, encodeURIComponent(to)).replace(/\{text\}/g, encodeURIComponent(text));
  return tpl.replace(/\{to\}/g, to).replace(/\{text\}/g, text);
}

/** @param cfg { url, method, contentType, bodyTemplate, authHeader, authValue } */
function smsRequest(cfg, to, text) {
  const method = String(cfg.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const headers = {};
  if (cfg.authHeader && cfg.authValue) headers[cfg.authHeader] = cfg.authValue;
  let url = String(cfg.url || '').replace(/\{to\}/g, encodeURIComponent(to)).replace(/\{text\}/g, encodeURIComponent(text));
  let body;
  if (method === 'POST') {
    headers['Content-Type'] = cfg.contentType || 'application/json';
    body = smsBody(cfg.bodyTemplate, headers['Content-Type'], to, text);
  } else if (cfg.bodyTemplate) {
    url += (url.includes('?') ? '&' : '?') + smsBody(cfg.bodyTemplate, 'application/x-www-form-urlencoded', to, text);
  }
  return { url, init: { method, headers, ...(body !== undefined ? { body } : {}) } };
}

async function sendSms(cfg, to, text) {
  if (!cfg || !cfg.url) return { ok: false, error: 'not_configured' };
  try {
    const { url, init } = smsRequest(cfg, to, text);
    // The gateway address is typed by the clinic: it goes through core/http (https only, no private / internal
    // addresses — checked again after DNS — and no redirects), never straight to fetch.
    const httpCore = require('../../core/http'); // eslint-disable-line global-require
    const check = httpCore.validateUrl(url);
    if (check.error) return { ok: false, error: 'blocked_url' };
    let status; let raw;
    if (transport.fetch !== defaultFetch) { // tests replace the transport (no network)
      const res = await call(url, { ...init, redirect: 'error' });
      status = res.status; raw = await res.text().catch(() => '');
    } else {
      try {
        const r = await httpCore.request(url, { method: init.method, headers: init.headers, body: init.body === undefined ? null : init.body, timeoutMs: TIMEOUT_MS, redirects: 0 });
        status = r.status; raw = r.body;
      } catch (e) { return { ok: false, error: e instanceof httpCore.BlockedError ? 'blocked_url' : short(e.message) }; }
    }
    if (status < 200 || status >= 300) return { ok: false, error: short(`HTTP ${status} ${raw}`) };
    let id = null;
    try { const j = JSON.parse(raw); id = j.sid || j.id || j.message_id || j.MessageID || (j.data && (j.data.MessageID || j.data.message_id || j.data.id)) || null; } catch { id = null; }
    return { ok: true, id: id ? String(id).slice(0, 120) : null };
  } catch (err) {
    return { ok: false, error: short(err.name === 'AbortError' ? 'timeout' : err.message) };
  }
}

// ---------------------------------------------------------------- e-mail
async function sendEmail({ to, subject, html, replyTo, businessId }) {
  if (!(await mailer.configuredFor(businessId))) return { ok: false, error: 'not_configured' };
  try {
    const sent = await mailer.send({ to, subject, html, replyTo, businessId, kind: 'reminders' });
    return sent ? { ok: true } : { ok: false, error: 'not_configured' };
  } catch (err) {
    return { ok: false, error: short(err.message) };
  }
}

// ---------------------------------------------------------------- click-to-chat (staff send it themselves)
const waMeLink = (to, text) => `https://wa.me/${to}?text=${encodeURIComponent(text)}`;

module.exports = { transport, GRAPH_VERSION, msisdn, maskPhone, maskEmail, waTemplatePayload, sendWhatsApp, smsBody, smsRequest, sendSms, sendEmail, waMeLink };
