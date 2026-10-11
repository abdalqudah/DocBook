// CRM → bulk e-mail. A campaign is a subject, a text (with {name} / {organization}) and an optional button, sent from
// the platform's address to the contacts chosen for it (CRM contacts by filter or one by one, and pasted addresses).
// A minute timer sends a few at a time so a campaign never goes over its own limits (so many an hour and a day) nor the
// platform's overall limits, which cover every campaign together (the mail provider's quota). Every e-mail carries an
// unsubscribe link; an address that unsubscribed is never e-mailed by a campaign again.
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const brand = require('../../config/brand');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { translator } = require('../../core/i18n');

const KEY = 'mail_campaigns';
const STATUSES = ['draft', 'sending', 'paused', 'done', 'cancelled'];
const DEFAULTS = { per_hour: 100, per_day: 500 };
const MAX_RECIPIENTS = 10000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const str = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const int = (v) => (/^\d+$/.test(String(v || '').trim()) ? Number(v) : NaN);
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[A-Za-z]{2,24}$/;
const parse = (v) => { try { return JSON.parse(v || '{}') || {}; } catch { return {}; } };
const actx = (ctx) => ({ ...ctx, businessId: null });
const root = () => String(config.appUrl).replace(/\/+$/, '');
const count = (q) => q.count({ n: '*' }).then((r) => Number(r[0].n));

/** The platform's overall limits (every campaign together). */
async function settings() {
  const row = await knex('platform_settings').where({ key: KEY }).first('value').catch(() => null);
  return { ...DEFAULTS, ...parse(row && row.value) };
}
async function saveSettings(ctx, body) {
  const s = { per_hour: int(body.per_hour), per_day: int(body.per_day) };
  const errors = {};
  if (!(s.per_hour >= 1 && s.per_hour <= 10000)) errors.per_hour = 'Enter a number from 1 to 10000.';
  if (!(s.per_day >= 1 && s.per_day <= 100000)) errors.per_day = 'Enter a number from 1 to 100000.';
  if (!errors.per_hour && !errors.per_day && s.per_day < s.per_hour) errors.per_day = 'The daily limit cannot be less than the hourly limit.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const value = JSON.stringify(s);
  await knex('platform_settings').insert({ key: KEY, value }).onConflict('key').merge({ value, updated_at: new Date() });
  await audit.record(actx(ctx), 'crm.campaign_limits', { entityType: 'platform', entityId: KEY, newValues: s });
  return s;
}

/** The counts of a campaign's recipients by status. */
async function counts(ids) {
  const out = {};
  if (!ids.length) return out;
  const rows = await knex('mail_campaign_recipients').whereIn('campaign_id', ids).groupBy('campaign_id', 'status').select('campaign_id', 'status').count({ n: '*' });
  rows.forEach((r) => { const c = out[r.campaign_id] || (out[r.campaign_id] = { queued: 0, sent: 0, failed: 0, skipped: 0, total: 0 }); c[r.status] = Number(r.n); c.total += Number(r.n); });
  return out;
}
const empty = () => ({ queued: 0, sent: 0, failed: 0, skipped: 0, total: 0 });

async function list() {
  const rows = await knex('mail_campaigns').orderBy('id', 'desc').limit(200);
  const n = await counts(rows.map((r) => r.id));
  rows.forEach((r) => { r.n = n[r.id] || empty(); });
  return rows;
}

async function get(id) {
  const c = await knex('mail_campaigns').where({ id: Number(id) || 0 }).first();
  if (!c) throw E.notFound('Campaign');
  c.n = (await counts([c.id]))[c.id] || empty();
  c.recipients = await knex('mail_campaign_recipients').where({ campaign_id: c.id })
    .orderByRaw("CASE status WHEN 'failed' THEN 0 WHEN 'queued' THEN 1 WHEN 'sent' THEN 2 ELSE 3 END").orderBy('id').limit(300);
  const now = Date.now();
  [c.lastHour, c.lastDay] = await Promise.all([
    count(knex('mail_campaign_recipients').where({ campaign_id: c.id }).where('sent_at', '>', new Date(now - HOUR))),
    count(knex('mail_campaign_recipients').where({ campaign_id: c.id }).where('sent_at', '>', new Date(now - DAY))),
  ]);
  return c;
}
const editable = (c) => ['draft', 'paused'].includes(c.status);

function clean(body) {
  const errors = {};
  const row = {
    name: str(body.name, 190), subject: str(body.subject, 255), body: str(body.body, 20000),
    cta_label: str(body.cta_label, 80) || null, cta_url: str(body.cta_url, 500) || null,
    locale: body.locale === 'en' ? 'en' : 'ar', per_hour: int(body.per_hour), per_day: int(body.per_day),
    start_at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(body.start_at || '')) ? new Date(body.start_at) : null,
  };
  if (!row.name) errors.name = 'Required.';
  if (!row.subject) errors.subject = 'Required.';
  if (!row.body) errors.body = 'Required.';
  if (row.cta_url && !/^https?:\/\/[^\s"'<>]+$/i.test(row.cta_url)) errors.cta_url = 'Enter a web address starting with https://';
  if (row.cta_url && !row.cta_label) errors.cta_label = 'Enter the button text.';
  if (!(row.per_hour >= 1 && row.per_hour <= 10000)) errors.per_hour = 'Enter a number from 1 to 10000.';
  if (!(row.per_day >= 1 && row.per_day <= 100000)) errors.per_day = 'Enter a number from 1 to 100000.';
  if (!errors.per_hour && !errors.per_day && row.per_day < row.per_hour) errors.per_day = 'The daily limit cannot be less than the hourly limit.';
  if (Object.keys(errors).length) throw E.validation(errors);
  return row;
}

async function create(ctx, body) {
  const row = clean(body);
  const [id] = await knex('mail_campaigns').insert({ ...row, status: 'draft', created_by: ctx.userId || null });
  await audit.record(actx(ctx), 'crm.campaign_created', { entityType: 'mail_campaign', entityId: id, newValues: { name: row.name, subject: row.subject } });
  return id;
}
async function update(ctx, id, body) {
  const c = await get(id);
  if (!editable(c)) throw E.validation({ name: 'Pause the campaign to change it.' });
  const row = clean(body);
  await knex('mail_campaigns').where({ id: c.id }).update({ ...row, updated_at: new Date() });
  await audit.record(actx(ctx), 'crm.campaign_updated', { entityType: 'mail_campaign', entityId: c.id, newValues: { name: row.name, subject: row.subject, per_hour: row.per_hour, per_day: row.per_day } });
}

/** CRM contacts with an e-mail that can be added (not unsubscribed). filters: q, kind, stage, country, source, ids. */
async function audience(f = {}, limit = MAX_RECIPIENTS) {
  const crm = require('./crm.service'); // eslint-disable-line global-require
  const q = knex('crm_contacts as c').whereNotNull('c.email').where('c.email', '<>', '')
    .whereRaw('LOWER(c.email) NOT IN (SELECT email FROM mail_unsubscribes)')
    .select('c.id', 'c.name', 'c.organization', 'c.email', 'c.kind', 'c.stage', 'c.country', 'c.city', 'c.source').orderBy('c.name').limit(limit);
  if (Array.isArray(f.ids)) q.whereIn('c.id', f.ids.length ? f.ids : [0]);
  if (crm.KINDS.includes(f.kind)) q.where('c.kind', f.kind);
  if (crm.STAGES.includes(f.stage)) q.where('c.stage', f.stage);
  if (crm.SOURCES.includes(f.source)) q.where('c.source', f.source);
  if (/^[A-Z]{2}$/.test(String(f.country || ''))) q.where('c.country', f.country);
  if (f.q && String(f.q).trim()) {
    const s = `%${String(f.q).trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    q.andWhere((w) => w.where('c.name', 'like', s).orWhere('c.organization', 'like', s).orWhere('c.email', 'like', s).orWhere('c.city', 'like', s));
  }
  return q;
}

/** Pasted addresses: one per line, "email", "email, name" or "Name <email>". */
function pasted(text) {
  const out = [];
  String(text || '').split(/\r?\n/).slice(0, MAX_RECIPIENTS).forEach((line) => {
    const l = line.trim();
    if (!l) return;
    const angle = l.match(/^(.*)<([^>]+)>$/);
    let email; let name = null;
    if (angle) { email = angle[2].trim(); name = angle[1].replace(/["']/g, '').trim() || null; } else {
      const [a, ...rest] = l.split(/[,;\t]/).map((x) => x.trim());
      email = a; name = rest.join(' ').trim() || null;
    }
    if (EMAIL.test(email)) out.push({ email: email.toLowerCase(), name: name ? name.slice(0, 190) : null, organization: null, contact_id: null });
  });
  return out;
}

/**
 * Adds recipients: body.scope = 'filter' takes every contact the filter matches (body.q / kind / stage / country /
 * source), otherwise the ticked body.contact ids; body.emails adds pasted addresses. An address already in the campaign
 * or unsubscribed is left out. → { added, skipped }
 */
async function addRecipients(ctx, id, body) {
  const c = await get(id);
  if (['done', 'cancelled'].includes(c.status)) throw E.validation({ emails: 'This campaign is finished.' });
  let people = [];
  if (body.scope === 'filter') {
    people = await audience({ q: body.q, kind: body.kind, stage: body.stage, country: String(body.country || '').toUpperCase(), source: body.source });
  } else {
    const ids = [].concat(body.contact || []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_RECIPIENTS);
    if (ids.length) people = await audience({ ids });
  }
  const list = [...people.map((p) => ({ email: String(p.email).trim().toLowerCase(), name: p.name || null, organization: p.organization || null, contact_id: p.id })), ...pasted(body.emails)]
    .filter((p) => EMAIL.test(p.email));
  if (!list.length) throw E.validation({ emails: 'Choose contacts or paste e-mail addresses.' });
  const have = new Set((await knex('mail_campaign_recipients').where({ campaign_id: c.id }).pluck('email')).map((e) => e.toLowerCase()));
  const blocked = new Set(await knex('mail_unsubscribes').whereIn('email', list.map((p) => p.email)).pluck('email'));
  const rows = [];
  list.forEach((p) => {
    if (have.has(p.email) || blocked.has(p.email)) return;
    have.add(p.email);
    rows.push({ campaign_id: c.id, contact_id: p.contact_id, email: p.email, name: p.name, organization: p.organization, status: 'queued', token: crypto.randomBytes(20).toString('hex') });
  });
  const room = Math.max(0, MAX_RECIPIENTS - c.n.total);
  const take = rows.slice(0, room);
  for (let i = 0; i < take.length; i += 500) await knex('mail_campaign_recipients').insert(take.slice(i, i + 500)); // eslint-disable-line no-await-in-loop
  await audit.record(actx(ctx), 'crm.campaign_recipients_added', { entityType: 'mail_campaign', entityId: c.id, newValues: { added: take.length } });
  return { added: take.length, skipped: list.length - take.length };
}

/** Removes the recipients not sent yet (to choose again). */
async function clearQueued(ctx, id) {
  const c = await get(id);
  if (!editable(c)) throw E.validation({ emails: 'Pause the campaign first.' });
  const n = await knex('mail_campaign_recipients').where({ campaign_id: c.id, status: 'queued' }).del();
  await audit.record(actx(ctx), 'crm.campaign_recipients_cleared', { entityType: 'mail_campaign', entityId: c.id, newValues: { removed: n } });
  return n;
}

async function setStatus(ctx, id, action) {
  const c = await get(id);
  const now = new Date();
  if (action === 'start') {
    if (!editable(c)) throw E.validation({ status: 'This campaign cannot be started.' });
    if (!c.n.queued) throw E.validation({ status: 'Add recipients first.' });
    const mailer = require('../../core/mailer'); // eslint-disable-line global-require
    if (!(await mailer.configuredFor(null))) throw E.validation({ status: 'Set up the platform e-mail first (Admin → Settings).' });
    await knex('mail_campaigns').where({ id: c.id }).update({ status: 'sending', started_at: c.started_at || now, last_error: null, updated_at: now });
  } else if (action === 'pause') {
    if (c.status !== 'sending') throw E.validation({ status: 'The campaign is not sending.' });
    await knex('mail_campaigns').where({ id: c.id }).update({ status: 'paused', updated_at: now });
  } else if (action === 'cancel') {
    if (!['draft', 'sending', 'paused'].includes(c.status)) throw E.validation({ status: 'The campaign is already finished.' });
    await knex('mail_campaign_recipients').where({ campaign_id: c.id, status: 'queued' }).update({ status: 'skipped', error: 'cancelled' });
    await knex('mail_campaigns').where({ id: c.id }).update({ status: 'cancelled', finished_at: now, updated_at: now });
  } else throw E.validation({ status: 'Choose a valid value.' });
  await audit.record(actx(ctx), `crm.campaign_${action}`, { entityType: 'mail_campaign', entityId: c.id, oldValues: { status: c.status } });
}

async function remove(ctx, id) {
  const c = await get(id);
  if (c.status === 'sending') throw E.validation({ status: 'Pause or cancel the campaign first.' });
  await knex('mail_campaigns').where({ id: c.id }).del();
  await audit.record(actx(ctx), 'crm.campaign_deleted', { entityType: 'mail_campaign', entityId: c.id, oldValues: { name: c.name, sent: c.n.sent } });
}

// {name} without a name falls back to the clinic's name, then to "Doctor"; {organization} to the name.
const fill = (text, r, locale = 'ar') => {
  const v = { name: (r.name || '').trim() || (r.organization || '').trim() || translator(locale)('camp.name_fallback'), organization: (r.organization || '').trim() || (r.name || '').trim(), email: r.email || '' };
  return String(text || '').replace(/\{(name|organization|email)\}/g, (m, k) => v[k]);
};
function message(c, r) {
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  const t = translator(c.locale);
  const href = `${root()}/unsubscribe/${r.token}`;
  const subject = fill(c.subject, r, c.locale).replace(/\s+/g, ' ').trim();
  const html = mailer.layout({ locale: c.locale, title: subject, body: fill(c.body, r, c.locale), cta: c.cta_url ? c.cta_label : null, href: c.cta_url,
    foot: { text: t('camp.foot_text', { brand: brand.name }), label: t('camp.unsubscribe'), href } });
  return { to: r.email, subject, html, kind: 'campaign', headers: { 'List-Unsubscribe': `<${href}>` } };
}

/** Sends the campaign to one address (the admin's own) to check how it looks; nothing is recorded as sent. */
async function testSend(ctx, id, to) {
  const c = await get(id);
  const email = str(to, 190).toLowerCase();
  if (!EMAIL.test(email)) throw E.validation({ test_to: 'Enter a valid email address.' });
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  if (!(await mailer.configuredFor(null))) throw E.validation({ test_to: 'Set up the platform e-mail first (Admin → Settings).' });
  const sample = c.recipients.find((r) => r.status === 'queued') || {};
  const ok = await mailer.send(message(c, { email, name: sample.name || '', organization: sample.organization || '', token: 'test' })).catch(() => false);
  if (!ok) throw E.validation({ test_to: 'The e-mail could not be sent. Check the platform e-mail settings.' });
}

let running = false;
/**
 * Every minute: sends the next few e-mails of each campaign that is sending, within its limits (sent in the last hour /
 * 24 hours) and the platform's (all campaigns), spread through the hour. A campaign with nothing left is marked done
 * and the admin is told. `now` is injectable for tests.
 */
async function tick(now = new Date()) {
  if (running) return { sent: 0, failed: 0 };
  running = true;
  try {
    const camps = await knex('mail_campaigns').where({ status: 'sending' }).where((w) => w.whereNull('start_at').orWhere('start_at', '<=', now)).orderBy('id');
    if (!camps.length) return { sent: 0, failed: 0 };
    const mailer = require('../../core/mailer'); // eslint-disable-line global-require
    if (!(await mailer.configuredFor(null))) {
      await knex('mail_campaigns').whereIn('id', camps.map((c) => c.id)).update({ last_error: 'email_not_configured' });
      return { sent: 0, failed: 0 };
    }
    const g = await settings();
    const hourAgo = new Date(now.getTime() - HOUR); const dayAgo = new Date(now.getTime() - DAY);
    let gHour = g.per_hour - await count(knex('mail_campaign_recipients').where('sent_at', '>', hourAgo));
    let gDay = g.per_day - await count(knex('mail_campaign_recipients').where('sent_at', '>', dayAgo));
    let sent = 0; let failed = 0;
    for (const c of camps) { // eslint-disable-line no-restricted-syntax
      const cHour = c.per_hour - await count(knex('mail_campaign_recipients').where({ campaign_id: c.id }).where('sent_at', '>', hourAgo)); // eslint-disable-line no-await-in-loop
      const cDay = c.per_day - await count(knex('mail_campaign_recipients').where({ campaign_id: c.id }).where('sent_at', '>', dayAgo)); // eslint-disable-line no-await-in-loop
      const n = Math.min(cHour, cDay, gHour, gDay, Math.max(1, Math.ceil(c.per_hour / 60)));
      if (n > 0) {
        const batch = await knex('mail_campaign_recipients').where({ campaign_id: c.id, status: 'queued' }).orderBy('id').limit(n); // eslint-disable-line no-await-in-loop
        for (const r of batch) { // eslint-disable-line no-restricted-syntax
          if (await knex('mail_unsubscribes').where({ email: r.email }).first('id')) { // eslint-disable-line no-await-in-loop
            await knex('mail_campaign_recipients').where({ id: r.id }).update({ status: 'skipped', error: 'unsubscribed' }); // eslint-disable-line no-await-in-loop
            continue; // eslint-disable-line no-continue
          }
          let ok = false; let error = null;
          try { ok = await mailer.send(message(c, r)); if (!ok) error = 'email_not_configured'; } catch (e) { error = String(e.message || e).slice(0, 255); } // eslint-disable-line no-await-in-loop
          await knex('mail_campaign_recipients').where({ id: r.id }).update({ status: ok ? 'sent' : 'failed', error, sent_at: now }); // eslint-disable-line no-await-in-loop
          if (r.contact_id) await knex('crm_activities').insert({ contact_id: r.contact_id, kind: 'email', body: `${fill(c.subject, r, c.locale)}\n\n(${c.name})`.slice(0, 8000), status: ok ? 'sent' : 'failed', user_id: c.created_by || null }).catch(() => {}); // eslint-disable-line no-await-in-loop
          gHour -= 1; gDay -= 1;
          if (ok) sent += 1; else failed += 1;
        }
      }
      if (!(await knex('mail_campaign_recipients').where({ campaign_id: c.id, status: 'queued' }).first('id'))) { // eslint-disable-line no-await-in-loop
        await knex('mail_campaigns').where({ id: c.id }).update({ status: 'done', finished_at: now, updated_at: now }); // eslint-disable-line no-await-in-loop
        const n2 = (await counts([c.id]))[c.id] || empty(); // eslint-disable-line no-await-in-loop
        await require('../platformnotify/notify.service').admin('campaign_done', { name: c.name, sent: n2.sent, failed: n2.failed }, { link: `/admin/crm/campaigns/${c.id}`, severity: 'success', dedupeKey: `campaign_done:${c.id}` }); // eslint-disable-line global-require, no-await-in-loop
      }
      if (gHour <= 0 || gDay <= 0) break;
    }
    return { sent, failed };
  } finally { running = false; }
}

/** The unsubscribe link: the address and whether it is already unsubscribed (null for an unknown link). */
async function byToken(token) {
  if (!/^[a-f0-9]{40}$/.test(String(token || ''))) return null;
  const r = await knex('mail_campaign_recipients').where({ token }).first('id', 'email', 'campaign_id');
  if (!r) return null;
  r.done = Boolean(await knex('mail_unsubscribes').where({ email: r.email }).first('id'));
  return r;
}
async function unsubscribe(token) {
  const r = await byToken(token);
  if (!r) return false;
  if (!r.done) await knex('mail_unsubscribes').insert({ email: r.email, campaign_id: r.campaign_id }).onConflict('email').ignore();
  await knex('mail_campaign_recipients').where({ email: r.email, status: 'queued' }).update({ status: 'skipped', error: 'unsubscribed' });
  return true;
}

module.exports = {
  KEY, STATUSES, DEFAULTS, MAX_RECIPIENTS, settings, saveSettings, list, get, editable, create, update, audience, pasted, addRecipients, clearQueued,
  setStatus, remove, testSend, tick, byToken, unsubscribe, fill,
};
