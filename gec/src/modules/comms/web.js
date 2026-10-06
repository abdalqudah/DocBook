// Staff: communication centre (inbox + sent log), the message composer on lead / student pages, template editor
// (English / Arabic, per channel) and the channel settings (e-mail, SMS, WhatsApp) with encrypted credentials.
const express = require('express');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { randomToken } = require('../../core/tokens');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah, ok, idParam } = require('../../core/http');
const { E } = require('../../core/errors');
const { validate, z, str, reqStr, optEmail, bool } = require('../../core/validate');
const settings = require('../settings/settings.service');
const settingsWeb = require('../settings/web');
const nav = require('../staff/nav');
const registry = require('../staff/registry');
const leads = require('../crm/leads.service');
const students = require('../crm/students.service');
const people = require('../crm/people');
const templates = require('./templates');
const channels = require('./channels');
const comms = require('./comms.service');
const email = require('./email');
const sms = require('./sms');
const whatsapp = require('./whatsapp');
require('./hooks');

nav.add('communication', { key: 'messages', href: '/staff/messages', icon: 'inbox', perms: ['comms.view'], badge: async (req) => comms.unreadCount(req.staff) });
nav.add('communication', { key: 'templates', href: '/staff/templates', icon: 'file-text', perms: ['templates.manage'] });
settingsWeb.addSection({ key: 'email', icon: 'mail', href: '/staff/settings/email', perms: ['integrations.manage'] });
settingsWeb.addSection({ key: 'sms', icon: 'message-square', href: '/staff/settings/sms', perms: ['integrations.manage'] });
settingsWeb.addSection({ key: 'whatsapp', icon: 'message-circle', href: '/staff/settings/whatsapp', perms: ['integrations.manage'] });
registry.addAttention(async (req) => {
  if (!req.can('comms.view')) return [];
  const rows = await comms.base(req.staff).where('m.direction', 'in').whereNull('m.read_at').orderBy('m.created_at', 'desc').limit(10).select(comms.COLS);
  return rows.map((m) => ({ kind: 'message', icon: m.channel === 'email' ? 'mail' : 'message-circle', tone: 'brand', title: req.t('attention.message_in', { name: people.fullName({ first_name: m.student_first || m.lead_first, last_name: m.student_last || m.lead_last }), channel: req.t(`channels.${m.channel}`) }), sub: String(m.body || m.subject || '').slice(0, 90), href: `/staff/messages/${m.id}`, chip: req.t('comms.unread'), due: m.created_at }));
});

const router = express.Router();
const CH = ['email', 'sms', 'whatsapp'];

/** Template variables for a person (lead or student). */
async function varsFor(lead, student) {
  const p = student || lead;
  const branding = await settings.get('branding');
  const counsellor = p && p.counsellor_id ? await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', p.counsellor_id).first('u.name') : null;
  return { student_name: people.fullName(p), counsellor_name: counsellor ? counsellor.name : '', company_name: branding.legal_name, link: `${config.appUrl}/portal` };
}

async function personFor(req, body) {
  const leadId = /^\d+$/.test(String(body.lead_id || '')) ? Number(body.lead_id) : null;
  const studentId = /^\d+$/.test(String(body.student_id || '')) ? Number(body.student_id) : null;
  if (!leadId && !studentId) throw E.validation({ to: 'Choose a person.' });
  const student = studentId ? await students.get(req.staff, studentId) : null;
  const lead = leadId ? await leads.get(req.staff, leadId) : null;
  return { lead, student, p: student || lead };
}
const addressFor = (p, channel) => (channel === 'email' ? p.email : (channel === 'whatsapp' ? p.whatsapp || p.phone : p.phone));

/** Template choices for the composer: built-in keys plus custom templates. */
async function templateOptions(req) {
  const custom = await knex('message_templates').where('key', 'like', 'custom_%').where({ is_active: true }).distinct('key', 'name');
  return [...Object.keys(templates.DEFAULTS).map((k) => ({ value: k, label: req.t(`templates.names.${k}`) })), ...custom.map((c) => ({ value: c.key, label: c.name || c.key }))];
}

// Composer data for the lead and student pages.
router.get(/^\/(leads|students)\/\d+$/, ah(async (req, res, next) => {
  if (req.can('comms.send')) res.locals.compose = { channels: await channels.status(), templates: await templateOptions(req), defaultCode: ((await settings.get('integration.whatsapp')) || {}).default_country_code || '' };
  next();
}));

// ------------------------------------------------------------------ Communication centre
router.get('/messages', can('comms.view'), ah(async (req, res) => {
  const box = ['inbox', 'sent', 'all'].includes(req.query.box) ? req.query.box : 'inbox';
  const page = Math.max(1, Number(req.query.page) || 1);
  const q = comms.base(req.staff);
  if (box === 'inbox') q.where('m.direction', 'in'); else if (box === 'sent') q.where('m.direction', 'out');
  if (CH.includes(req.query.channel)) q.where('m.channel', req.query.channel);
  if (['failed', 'not_configured', 'unread'].includes(req.query.status)) { if (req.query.status === 'unread') q.whereNull('m.read_at').where('m.direction', 'in'); else q.where('m.status', req.query.status); }
  const s = String(req.query.q || '').trim().slice(0, 100);
  if (s) q.where((w) => w.where('m.subject', 'like', `%${s}%`).orWhere('m.body', 'like', `%${s}%`).orWhere('m.to_address', 'like', `%${s}%`).orWhere('m.from_address', 'like', `%${s}%`).orWhere('l.first_name', 'like', `%${s}%`).orWhere('s.first_name', 'like', `%${s}%`));
  const [{ n }] = await q.clone().clearSelect().count({ n: 'm.id' });
  const rows = await q.select(comms.COLS).orderBy('m.created_at', 'desc').limit(30).offset((page - 1) * 30);
  res.page('pages/staff/comms/messages', { layout: 'staff', title: req.t('nav.messages'), rows, box, status: await channels.status(), unread: await comms.unreadCount(req.staff), meta: { total: Number(n), page, pages: Math.max(1, Math.ceil(Number(n) / 30)) } });
}));

router.get('/messages/render', can('comms.send'), ah(async (req, res) => {
  const key = String(req.query.key || '');
  const channel = CH.includes(req.query.channel) ? req.query.channel : 'email';
  const { lead, student, p } = await personFor(req, req.query);
  const locale = p.preferred_locale === 'ar' ? 'ar' : 'en';
  const msg = await templates.render(key, locale, await varsFor(lead, student), channel) || await templates.render(key, locale, await varsFor(lead, student), 'email');
  if (!msg) throw E.notFound('Template');
  ok(res, { subject: msg.subject, body: msg.body });
}));

router.post('/messages/send', can('comms.send'), ah(async (req, res) => {
  const d = validate(z.object({ channel: z.enum(['email', 'sms', 'whatsapp']), subject: str(255), body: reqStr(5000), template_key: str(60) }), req.body);
  const { lead, student, p } = await personFor(req, req.body);
  const to = addressFor(p, d.channel);
  const back = student ? `/staff/students/${student.id}` : `/staff/leads/${lead.id}`;
  if (!to) { flash(req, 'error', req.t(`comms.no_address_${d.channel}`)); return res.redirect(back); }
  if (d.channel === 'email' && !d.subject) { flash(req, 'error', req.t('comms.subject_required')); return res.redirect(back); }
  const r = await comms.send({ channel: d.channel, to, subject: d.subject || null, body: d.body, leadId: lead ? lead.id : (student ? null : null), studentId: student ? student.id : null, templateKey: d.template_key || null, actorId: req.user.id, locale: p.preferred_locale === 'ar' ? 'ar' : 'en' });
  if (r.sent) flash(req, 'ok', req.t('comms.sent'));
  else flash(req, 'error', r.reason === 'not_configured' ? req.t('comms.not_connected_saved', { channel: req.t(`channels.${d.channel}`) }) : req.t('comms.failed', { reason: r.reason }));
  return res.redirect(back);
}));

// WhatsApp click-to-chat: log the message, then open WhatsApp with the text filled in.
router.post('/messages/whatsapp-link', can('comms.send'), ah(async (req, res) => {
  const d = validate(z.object({ body: reqStr(4000) }), req.body);
  const { lead, student, p } = await personFor(req, req.body);
  const code = ((await settings.get('integration.whatsapp')) || {}).default_country_code || ((await settings.get('integration.sms')) || {}).default_country_code || '';
  const link = whatsapp.chatLink(p.whatsapp || p.phone, d.body, code);
  if (!link) { flash(req, 'error', req.t('comms.no_address_whatsapp')); return res.redirect(student ? `/staff/students/${student.id}` : `/staff/leads/${lead.id}`); }
  await comms.logManual({ channel: 'whatsapp', to: p.whatsapp || p.phone, body: d.body, leadId: lead ? lead.id : null, studentId: student ? student.id : null, actorId: req.user.id });
  return res.redirect(link);
}));

router.get('/messages/:id', can('comms.view'), ah(async (req, res) => {
  const m = await comms.base(req.staff).where('m.id', idParam(req.params.id)).first(comms.COLS);
  if (!m) throw E.notFound('Message');
  if (m.direction === 'in' && !m.read_at) await knex('messages').where({ id: m.id }).update({ read_at: new Date() });
  const thread = await comms.base(req.staff).where((w) => { if (m.student_id) w.where('m.student_id', m.student_id); else w.where('m.lead_id', m.lead_id); }).orderBy('m.created_at', 'desc').limit(20).select(comms.COLS);
  res.page('pages/staff/comms/message', { layout: 'staff', narrow: true, title: m.subject || req.t(`channels.${m.channel}`), m, thread, status: await channels.status() });
}));

// ------------------------------------------------------------------ Templates
router.get('/templates', can('templates.manage'), ah(async (req, res) => {
  const saved = await knex('message_templates').select('key', 'channel', 'locale', 'name', 'updated_at');
  const keys = [...new Set([...Object.keys(templates.DEFAULTS), ...saved.map((r) => r.key)])];
  const rows = keys.map((k) => ({ key: k, name: k.startsWith('custom_') ? (saved.find((r) => r.key === k) || {}).name || k : req.t(`templates.names.${k}`), custom: k.startsWith('custom_'), edited: saved.filter((r) => r.key === k).map((r) => `${r.channel}:${r.locale}`) }));
  res.page('pages/staff/comms/templates', { layout: 'staff', title: req.t('nav.templates'), rows });
}));

router.post('/templates', can('templates.manage'), ah(async (req, res) => {
  const d = validate(z.object({ name: reqStr(120) }), req.body);
  const slug = d.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || randomToken(4).toLowerCase();
  const key = `custom_${slug}`;
  if (!(await knex('message_templates').where({ key }).first())) {
    await knex('message_templates').insert({ key, channel: 'email', locale: 'en', name: d.name, subject: d.name, body: '', is_active: false, updated_by: req.user.id });
  }
  res.redirect(`/staff/templates/${key}`);
}));

function loadTemplateKey(key) {
  if (!/^[a-z0-9_]{2,60}$/.test(key)) throw E.notFound('Template');
  return key;
}

router.get('/templates/:key', can('templates.manage'), ah(async (req, res) => {
  const key = loadTemplateKey(req.params.key);
  const channel = CH.includes(req.query.channel) ? req.query.channel : 'email';
  if (!templates.DEFAULTS[key] && !(await knex('message_templates').where({ key }).first())) throw E.notFound('Template');
  const rows = await knex('message_templates').where({ key, channel });
  const loc = {};
  for (const l of ['en', 'ar']) {
    const saved = rows.find((r) => r.locale === l);
    const def = templates.DEFAULTS[key] ? templates.DEFAULTS[key][l] : null;
    loc[l] = { subject: saved ? saved.subject : (channel === 'email' && def ? def.subject : ''), body: saved && saved.body ? saved.body : (def ? def.body : ''), cta: saved ? saved.cta_label : (def ? def.cta : ''), custom: !!(saved && saved.body), saved };
  }
  const name = key.startsWith('custom_') ? ((await knex('message_templates').where({ key }).first()) || {}).name : req.t(`templates.names.${key}`);
  res.page('pages/staff/comms/template', { layout: 'staff', title: name, key, name, channel, loc, variables: templates.VARIABLES, isCustom: key.startsWith('custom_') });
}));

router.post('/templates/:key', can('templates.manage'), ah(async (req, res) => {
  const key = loadTemplateKey(req.params.key);
  const channel = CH.includes(req.body.channel) ? req.body.channel : 'email';
  if (!templates.DEFAULTS[key] && !(await knex('message_templates').where({ key }).first())) throw E.notFound('Template');
  const d = validate(z.object({ subject_en: str(255), body_en: str(5000), cta_en: str(80), subject_ar: str(255), body_ar: str(5000), cta_ar: str(80), name: str(120) }), req.body);
  const name = key.startsWith('custom_') ? (d.name || null) : null;
  for (const l of ['en', 'ar']) {
    const body = d[`body_${l}`];
    const def = templates.DEFAULTS[key] && templates.DEFAULTS[key][l];
    const same = def && channel === 'email' && body === def.body && (d[`subject_${l}`] || '') === def.subject && (d[`cta_${l}`] || '') === (def.cta || '');
    if (!body || same) { await knex('message_templates').where({ key, channel, locale: l }).del(); continue; } // eslint-disable-line no-await-in-loop, no-continue
    const row = { subject: channel === 'email' ? d[`subject_${l}`] || null : null, body, cta_label: channel === 'email' ? d[`cta_${l}`] || null : null, is_active: true, updated_by: req.user.id, updated_at: new Date(), ...(name ? { name } : {}) };
    const exists = await knex('message_templates').where({ key, channel, locale: l }).first('id'); // eslint-disable-line no-await-in-loop
    if (exists) await knex('message_templates').where({ id: exists.id }).update(row); // eslint-disable-line no-await-in-loop
    else await knex('message_templates').insert({ key, channel, locale: l, name: name || (key.startsWith('custom_') ? key : null), ...row }); // eslint-disable-line no-await-in-loop
  }
  if (name) await knex('message_templates').where({ key }).update({ name });
  await audit.record(req.ctx, 'template.updated', { entityType: 'message_template', entityId: null, newValues: { key, channel } });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(`/staff/templates/${key}?channel=${channel}`);
}));

router.post('/templates/:key/reset', can('templates.manage'), ah(async (req, res) => {
  const key = loadTemplateKey(req.params.key);
  const channel = CH.includes(req.body.channel) ? req.body.channel : 'email';
  await knex('message_templates').where({ key, channel }).del();
  await audit.record(req.ctx, 'template.reset', { entityType: 'message_template', newValues: { key, channel } });
  flash(req, 'ok', req.t('templates.reset_done'));
  res.redirect(key.startsWith('custom_') && channel === 'email' ? '/staff/templates' : `/staff/templates/${key}?channel=${channel}`);
}));

// E-mail preview as its own document (the e-mail's inline styles need a relaxed policy, so it is framed).
router.get('/templates/:key/preview', can('templates.manage'), ah(async (req, res) => {
  const key = loadTemplateKey(req.params.key);
  const locale = req.query.locale === 'ar' ? 'ar' : 'en';
  const branding = await settings.get('branding');
  const sample = Object.fromEntries(templates.VARIABLES.map((v) => [v, `[${v}]`]));
  const msg = await templates.render(key, locale, { ...sample, company_name: branding.legal_name, student_name: locale === 'ar' ? 'سارة أحمد' : 'Sara Ahmad' });
  if (!msg) throw E.notFound('Template');
  const html = await email.layout({ locale, title: msg.subject, body: msg.body, cta: msg.cta, href: config.appUrl });
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; frame-ancestors 'self'");
  res.send(html);
}));

// ------------------------------------------------------------------ Channel settings
const secretField = (current, incoming) => (incoming ? secrets.encrypt(incoming) : current || null);

router.get('/settings/email', can('integrations.manage'), ah(async (req, res) => {
  const s = (await settings.get('integration.email')) || {};
  const c = await email.currentConfig();
  res.page('pages/staff/settings/email', { layout: 'staff', narrow: true, title: req.t('settings.email'), s, connected: !!(c && c.host && c.fromEmail), fromEnv: c && c.provider === 'env', hasPassword: !!s.password_enc });
}));
router.post('/settings/email', can('integrations.manage'), ah(async (req, res) => {
  const d = validate(z.object({ enabled: bool(), provider: z.enum(['smtp', 'google', 'microsoft']), host: str(190), port: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(65535).optional()), encryption: z.enum(['ssl', 'starttls', 'none']).optional(), username: str(190), password: str(300), from_email: optEmail(), from_name: str(120) }), req.body);
  if (d.enabled && d.provider === 'smtp' && !d.host) throw E.validation({ host: 'Required.' });
  if (d.enabled && !d.from_email) throw E.validation({ from_email: 'Required.' });
  const cur = (await settings.get('integration.email')) || {};
  await settings.set(req.ctx, 'integration.email', { enabled: d.enabled, provider: d.provider, host: d.host || '', port: d.port || null, encryption: d.encryption || 'ssl', username: d.username || '', password_enc: secretField(cur.password_enc, d.password), from_email: d.from_email || '', from_name: d.from_name || '' });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/settings/email');
}));
router.post('/settings/email/test', can('integrations.manage'), ah(async (req, res) => {
  const r = await comms.send({ channel: 'email', to: req.user.email, subject: req.t('integrations.test_subject'), body: req.t('integrations.test_body'), actorId: req.user.id, locale: req.locale });
  flash(req, r.sent ? 'ok' : 'error', r.sent ? req.t('integrations.test_sent', { to: req.user.email }) : req.t('integrations.test_failed', { reason: r.reason }));
  res.redirect('/staff/settings/email');
}));

router.get('/settings/sms', can('integrations.manage'), ah(async (req, res) => {
  const s = (await settings.get('integration.sms')) || {};
  res.page('pages/staff/settings/sms', { layout: 'staff', narrow: true, title: req.t('settings.sms'), s, connected: !!(await sms.currentConfig()), hasToken: !!s.auth_token_enc, hooks: { inbound: `${config.appUrl}/hooks/sms/twilio`, status: `${config.appUrl}/hooks/sms/twilio/status` } });
}));
router.post('/settings/sms', can('integrations.manage'), ah(async (req, res) => {
  const d = validate(z.object({ enabled: bool(), account_sid: str(64), auth_token: str(200), from_number: str(40), default_country_code: z.string().trim().regex(/^\d{0,4}$/, 'Digits only, e.g. 962.').optional() }), req.body);
  const cur = (await settings.get('integration.sms')) || {};
  if (d.enabled && (!d.account_sid || !d.from_number || !(d.auth_token || cur.auth_token_enc))) throw E.validation({ account_sid: 'Account SID, auth token and sender number are required to connect.' });
  await settings.set(req.ctx, 'integration.sms', { enabled: d.enabled, provider: 'twilio', account_sid: d.account_sid || '', auth_token_enc: secretField(cur.auth_token_enc, d.auth_token), from_number: d.from_number || '', default_country_code: d.default_country_code || '' });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/settings/sms');
}));

router.get('/settings/whatsapp', can('integrations.manage'), ah(async (req, res) => {
  const s = (await settings.get('integration.whatsapp')) || {};
  res.page('pages/staff/settings/whatsapp', { layout: 'staff', narrow: true, title: req.t('settings.whatsapp'), s, connected: !!(await whatsapp.currentConfig()), hasToken: !!s.access_token_enc, hasSecret: !!s.app_secret_enc, hook: `${config.appUrl}/hooks/whatsapp` });
}));
router.post('/settings/whatsapp', can('integrations.manage'), ah(async (req, res) => {
  const d = validate(z.object({ enabled: bool(), phone_number_id: z.string().trim().regex(/^\d{0,30}$/, 'Digits only.').optional(), business_account_id: str(40), access_token: str(1000), app_secret: str(200), display_number: str(40), default_country_code: z.string().trim().regex(/^\d{0,4}$/, 'Digits only, e.g. 962.').optional() }), req.body);
  const cur = (await settings.get('integration.whatsapp')) || {};
  if (d.enabled && (!d.phone_number_id || !(d.access_token || cur.access_token_enc))) throw E.validation({ phone_number_id: 'Phone number ID and access token are required to connect.' });
  await settings.set(req.ctx, 'integration.whatsapp', { enabled: d.enabled, phone_number_id: d.phone_number_id || '', business_account_id: d.business_account_id || '', access_token_enc: secretField(cur.access_token_enc, d.access_token), app_secret_enc: secretField(cur.app_secret_enc, d.app_secret), verify_token: cur.verify_token || randomToken(18), display_number: d.display_number || '', default_country_code: d.default_country_code || '' });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/settings/whatsapp');
}));

module.exports = router;
