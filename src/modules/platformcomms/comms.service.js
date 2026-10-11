// The platform's own e-mail and WhatsApp (Admin → Platform settings), for the platform owner's messages to clinics,
// warehouses, reps and prospects (the CRM) and for account e-mails when the server has no SMTP in its environment.
//   mail       SMTP: host, port, user, password (encrypted), from address and name
//   whatsapp   WhatsApp Cloud API: phone number id and token (encrypted); the public number for wa.me links, its default
//              text, and whether the public pages show a WhatsApp button
//   geo        look up the country / city of visitors' IP addresses on the Activity page (ipwho.is, admin-started)
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { E, AppError } = require('../../core/errors');

const KEY = 'platform_comms';
const DEFAULTS = {
  mail: { host: '', port: 465, user: '', pass_enc: null, from_email: '', from_name: '' },
  whatsapp: { phone_number_id: '', token_enc: null, public_number: '', public_text_ar: '', public_text_en: '', public_button: false, default_dial: '962' },
  geo: { lookup: false },
};

const parse = (v) => { try { return JSON.parse(v) || {}; } catch { return {}; } };
async function raw() {
  const row = await knex('platform_settings').where({ key: KEY }).first('value').catch(() => null);
  const v = row ? parse(row.value) : {};
  return { mail: { ...DEFAULTS.mail, ...(v.mail || {}) }, whatsapp: { ...DEFAULTS.whatsapp, ...(v.whatsapp || {}) }, geo: { ...DEFAULTS.geo, ...(v.geo || {}) } };
}

/** Settings for the page (secrets never leave: only whether they are set). */
const get = () => cache.remember('pcomms:all', async () => {
  const s = await raw();
  const pass = s.mail.pass_enc ? secrets.decrypt(s.mail.pass_enc) : null;
  const token = s.whatsapp.token_enc ? secrets.decrypt(s.whatsapp.token_enc) : null;
  return {
    mail: { ...s.mail, pass_enc: undefined, hasPassword: Boolean(pass), ready: Boolean(s.mail.host && s.mail.from_email) },
    whatsapp: { ...s.whatsapp, token_enc: undefined, hasToken: Boolean(token), ready: Boolean(s.whatsapp.phone_number_id && token) },
    geo: s.geo,
  };
}, 30_000);

/** SMTP for the mailer (password decrypted), or null when not set. */
async function smtp() {
  const s = await raw();
  if (!s.mail.host || !s.mail.from_email) return null;
  return { host: s.mail.host, port: Number(s.mail.port) || 465, user: s.mail.user || '', pass: s.mail.pass_enc ? secrets.decrypt(s.mail.pass_enc) || '' : '', from: s.mail.from_name ? `${s.mail.from_name} <${s.mail.from_email}>` : s.mail.from_email };
}
/** WhatsApp Cloud API credentials, or null. */
async function whatsapp() {
  const s = await raw();
  const token = s.whatsapp.token_enc ? secrets.decrypt(s.whatsapp.token_enc) : null;
  return s.whatsapp.phone_number_id && token ? { phoneNumberId: s.whatsapp.phone_number_id, token, dial: s.whatsapp.default_dial } : null;
}

const str = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const digits = (v) => String(v || '').replace(/\D/g, '');
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const enc = (v) => { try { return secrets.encrypt(v); } catch { throw new AppError('SECRETS_KEY', 'Set APP_KEY (or SESSION_SECRET) in the server environment to store credentials.', 409); } };

async function save(ctx, body) {
  const cur = await raw();
  const errors = {};
  const mail = {
    host: str(body.mail_host, 190).toLowerCase(), port: Number(body.mail_port) || 465, user: str(body.mail_user, 190),
    from_email: str(body.mail_from_email, 190).toLowerCase(), from_name: str(body.mail_from_name, 120), pass_enc: cur.mail.pass_enc,
  };
  if (mail.host && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(mail.host)) errors.mail_host = 'Enter the SMTP server, e.g. mail.medworks.app';
  if (![25, 465, 587, 2525].includes(mail.port)) errors.mail_port = 'Choose 465 (SSL) or 587 (STARTTLS).';
  if (mail.from_email && !EMAIL.test(mail.from_email)) errors.mail_from_email = 'Enter a valid email address.';
  if (mail.host && !mail.from_email) errors.mail_from_email = 'Enter the address e-mails are sent from.';
  if (body.mail_remove_password === '1') mail.pass_enc = null;
  if (str(body.mail_password, 300)) mail.pass_enc = enc(str(body.mail_password, 300));
  const wa = {
    phone_number_id: digits(body.wa_phone_number_id).slice(0, 40), token_enc: cur.whatsapp.token_enc,
    public_number: digits(body.wa_public_number).slice(0, 20), public_text_ar: str(body.wa_public_text_ar, 300), public_text_en: str(body.wa_public_text_en, 300),
    public_button: body.wa_public_button === '1', default_dial: digits(body.wa_default_dial).slice(0, 4) || '962',
  };
  if (wa.public_number && wa.public_number.length < 8) errors.wa_public_number = 'Enter the number with its country code, e.g. 9627XXXXXXXX.';
  if (wa.public_button && !wa.public_number) errors.wa_public_number = 'Enter the WhatsApp number to show the button.';
  if (body.wa_remove_token === '1') wa.token_enc = null;
  if (str(body.wa_token, 600)) wa.token_enc = enc(str(body.wa_token, 600));
  const geo = { lookup: body.geo_lookup === '1' };
  if (Object.keys(errors).length) throw E.validation(errors);
  const value = JSON.stringify({ mail, whatsapp: wa, geo });
  await knex('platform_settings').insert({ key: KEY, value }).onConflict('key').merge({ value, updated_at: new Date() });
  cache.forgetPrefix('pcomms:');
  require('../../core/mailer').resetPlatformSmtp(); // eslint-disable-line global-require
  await audit.record(ctx, 'platform.comms_updated', { entityType: 'platform', entityId: KEY, newValues: { mail_host: mail.host, mail_from: mail.from_email, wa_phone_number_id: wa.phone_number_id, wa_public_number: wa.public_number, wa_public_button: wa.public_button, geo_lookup: geo.lookup } });
}

/** wa.me link to the platform's public number with its default text (for the public pages and sharing). */
async function publicLink(locale = 'ar') {
  const s = (await get()).whatsapp;
  if (!s.public_number) return null;
  const text = (locale === 'en' && s.public_text_en) || s.public_text_ar || s.public_text_en || '';
  return `https://wa.me/${s.public_number}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/** Sends a WhatsApp text through the platform's number → { ok, error }. */
async function sendWhatsAppText(phone, text) {
  const cfg = await whatsapp();
  if (!cfg) return { ok: false, error: 'not_configured' };
  const ch = require('../messaging/channels'); // eslint-disable-line global-require
  const to = ch.msisdn(phone, cfg.dial);
  if (!to) return { ok: false, error: 'bad_number' };
  return ch.sendWhatsApp(cfg, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: String(text).slice(0, 4000) } });
}

module.exports = { KEY, get, smtp, whatsapp, save, publicLink, sendWhatsAppText };
