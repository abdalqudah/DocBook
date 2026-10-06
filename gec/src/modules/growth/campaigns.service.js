// Marketing campaigns (e-mail, SMS, WhatsApp) to a segment of leads or students. Only people who gave marketing
// consent and have not unsubscribed are ever included. Recipients are frozen when the campaign is launched and
// sent in small batches by a job; each one gets a private token for the unsubscribe link, the open pixel
// (e-mail, where the mail app loads images) and the tracked button (which only redirects to the campaign's own URL).
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const { randomToken } = require('../../core/tokens');
const settings = require('../settings/settings.service');
const people = require('../crm/people');
const email = require('../comms/email');
const comms = require('../comms/comms.service');
const templates = require('../comms/templates');
const jobs = require('../jobs');

const BATCH = 50;
const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map(String).filter(Boolean);

/** Normalises a segment from form input. */
function segmentFrom(b) {
  return {
    audience: ['students', 'subscribers'].includes(b.audience) ? b.audience : 'leads',
    stages: arr(b.stages).filter((x) => /^\d+$/.test(x)).map(Number), temperatures: arr(b.temperatures).filter((x) => ['cold', 'warm', 'hot'].includes(x)),
    sources: arr(b.sources).map((x) => x.slice(0, 40)), countries: arr(b.countries).map((x) => x.slice(0, 40)), degree: b.degree ? String(b.degree).slice(0, 30) : null,
    journey: arr(b.journey).map((x) => x.slice(0, 30)), counsellor_id: /^\d+$/.test(String(b.counsellor_id || '')) ? Number(b.counsellor_id) : null,
    min_score: /^\d+$/.test(String(b.min_score || '')) ? Number(b.min_score) : null, intake: b.intake && /^\d{4}-\d{2}$/.test(b.intake) ? b.intake : null,
  };
}

/** People in the segment who can receive marketing on this channel. */
function audienceQuery(seg, channel) {
  if (seg.audience === 'subscribers') {
    // Newsletter: confirmed (double opt-in) subscribers, e-mail only.
    const q = knex('newsletter_subscribers as p').where('p.status', 'confirmed');
    if (channel !== 'email') q.whereRaw('1 = 0');
    if (seg.countries && seg.countries.length) q.where((w) => seg.countries.forEach((c) => w.orWhereRaw('JSON_CONTAINS(p.interests, ?)', [JSON.stringify(c)])));
    if (seg.degree) q.where('p.degree', seg.degree);
    return q;
  }
  const students = seg.audience === 'students';
  const t = students ? 'students as p' : 'leads as p';
  const q = knex(t).where('p.consent_marketing', true).whereNull('p.unsubscribed_at');
  if (channel === 'email') q.whereNotNull('p.email').whereNot('p.email', ''); else q.where((w) => w.whereNotNull('p.phone').orWhereNotNull('p.whatsapp'));
  if (students) {
    q.whereNull('p.merged_into_id').whereNot('p.status', 'closed');
    if (seg.journey && seg.journey.length) q.whereIn('p.journey_stage', seg.journey);
    if (seg.countries && seg.countries.length) q.where((w) => seg.countries.forEach((c) => w.orWhereRaw('JSON_CONTAINS(p.pref_countries, ?)', [JSON.stringify(c)])));
    if (seg.degree) q.where('p.pref_degree', seg.degree);
    if (seg.intake) q.where('p.pref_intake', seg.intake);
  } else {
    q.where('p.status', 'open');
    if (seg.stages && seg.stages.length) q.whereIn('p.stage_id', seg.stages);
    if (seg.temperatures && seg.temperatures.length) q.whereIn('p.temperature', seg.temperatures);
    if (seg.sources && seg.sources.length) q.whereIn('p.source', seg.sources);
    if (seg.countries && seg.countries.length) q.where((w) => seg.countries.forEach((c) => w.orWhereRaw('JSON_CONTAINS(p.interest_countries, ?)', [JSON.stringify(c)])));
    if (seg.degree) q.where('p.interest_degree', seg.degree);
    if (seg.intake) q.where('p.interest_intake', seg.intake);
    if (seg.min_score !== null && seg.min_score !== undefined) q.where('p.score', '>=', seg.min_score);
  }
  if (seg.counsellor_id) q.where('p.counsellor_id', seg.counsellor_id);
  return q;
}

/** The same columns for every audience (subscribers have a single name and no phone). */
const colsOf = (seg) => (seg.audience === 'subscribers'
  ? ['p.id', 'p.name as first_name', knex.raw("'' as last_name"), 'p.email', knex.raw('NULL as phone'), knex.raw('NULL as whatsapp'), 'p.locale as preferred_locale']
  : ['p.id', 'p.first_name', 'p.last_name', 'p.email', 'p.phone', 'p.whatsapp', 'p.preferred_locale']);
const KEY = { leads: 'lead_id', students: 'student_id', subscribers: 'subscriber_id' };

async function preview(seg, channel) {
  const q = audienceQuery(seg, channel);
  const [{ n }] = await q.clone().count({ n: '*' });
  const sample = await q.clone().select(colsOf(seg)).orderBy('p.id', 'desc').limit(5);
  return { count: Number(n), sample };
}

const parse = (v) => (v && typeof v === 'object' ? v : (() => { try { return JSON.parse(v || '{}'); } catch { return {}; } })());

/** Freezes the recipient list and starts (or schedules) sending. */
async function launch(ctx, id, { scheduledAt = null } = {}) {
  const c = await knex('campaigns').where({ id }).first();
  if (!c) throw E.notFound('Campaign');
  if (c.status !== 'draft') throw E.conflict('NOT_DRAFT', 'This campaign was already launched.');
  if (!c.body_en && !c.body_ar) throw E.validation({ body_en: 'Write the message first.' });
  if (c.channel === 'email' && !c.subject_en && !c.subject_ar) throw E.validation({ subject_en: 'Add a subject.' });
  const seg = parse(c.segment);
  const rows = await audienceQuery(seg, c.channel).select(colsOf(seg));
  const seen = new Set(); const list = [];
  for (const r of rows) {
    const address = c.channel === 'email' ? String(r.email).toLowerCase() : (c.channel === 'whatsapp' ? r.whatsapp || r.phone : r.phone);
    if (!address || seen.has(address)) continue; // eslint-disable-line no-continue
    seen.add(address);
    list.push({ campaign_id: id, [KEY[seg.audience] || 'lead_id']: r.id, address, locale: r.preferred_locale === 'ar' ? 'ar' : 'en', token: randomToken(24) });
  }
  if (!list.length) throw E.validation({ segment: 'Nobody in this audience can receive marketing on this channel.' });
  for (let i = 0; i < list.length; i += 500) await knex('campaign_recipients').insert(list.slice(i, i + 500)); // eslint-disable-line no-await-in-loop
  await knex('campaigns').where({ id }).update({ status: scheduledAt ? 'scheduled' : 'sending', scheduled_at: scheduledAt, started_at: scheduledAt ? null : new Date(), updated_at: new Date() });
  await audit.record(ctx, 'campaign.launched', { entityType: 'campaign', entityId: id, newValues: { recipients: list.length, scheduled_at: scheduledAt } });
  return list.length;
}

async function cancel(ctx, id) {
  const c = await knex('campaigns').where({ id }).first();
  if (!c || !['scheduled', 'sending'].includes(c.status)) return;
  await knex('campaign_recipients').where({ campaign_id: id, status: 'queued' }).update({ status: 'skipped', error: 'cancelled' });
  await knex('campaigns').where({ id }).update({ status: 'cancelled', finished_at: new Date(), updated_at: new Date() });
  await audit.record(ctx, 'campaign.cancelled', { entityType: 'campaign', entityId: id });
}

function withUtm(url, c) {
  try {
    const u = new URL(url, config.appUrl);
    if (!u.searchParams.has('utm_source')) { u.searchParams.set('utm_source', 'gec'); u.searchParams.set('utm_medium', c.channel); u.searchParams.set('utm_campaign', c.slug); }
    return u.toString();
  } catch { return null; }
}

async function sendOne(c, r) {
  // Re-check consent at send time: someone may have unsubscribed after launch.
  let person;
  if (r.subscriber_id) {
    const sub = await knex('newsletter_subscribers').where({ id: r.subscriber_id }).first();
    person = sub && sub.status === 'confirmed' ? { first_name: sub.name || '', last_name: '', consent_marketing: true, unsubscribed_at: null } : null;
  } else person = r.student_id ? await knex('students').where({ id: r.student_id }).first() : await knex('leads').where({ id: r.lead_id }).first();
  if (!person || !person.consent_marketing || person.unsubscribed_at) {
    await knex('campaign_recipients').where({ id: r.id }).update({ status: 'skipped', error: 'no consent' });
    return;
  }
  const L = r.locale === 'ar' ? 'ar' : 'en';
  const pick = (f) => c[`${f}_${L}`] || c[`${f}_${L === 'ar' ? 'en' : 'ar'}`] || '';
  const branding = await settings.get('branding');
  const vars = { student_name: people.fullName(person), first_name: person.first_name, company_name: branding.legal_name };
  const subject = templates.fill(pick('subject'), vars);
  const body = templates.fill(pick('body'), vars);
  const unsub = `${config.appUrl}/u/${r.token}`;
  let res;
  if (c.channel === 'email') {
    const cta = c.cta_url ? `${config.appUrl}/c/c/${r.token}` : null;
    let html = await email.layout({ locale: L, title: subject, body, cta: cta ? pick('cta') || (L === 'ar' ? 'اعرف المزيد' : 'Learn more') : null, href: cta });
    const foot = L === 'ar' ? 'لا ترغب بهذه الرسائل؟' : 'Don’t want these e-mails?';
    const unsubLabel = L === 'ar' ? 'إلغاء الاشتراك' : 'Unsubscribe';
    html = html.replace(/<\/body>/, `<p style="text-align:center;font:12px Arial,sans-serif;color:#5b675f">${foot} <a href="${unsub}" style="color:#5b675f">${unsubLabel}</a></p><img src="${config.appUrl}/c/o/${r.token}.gif" width="1" height="1" alt=""></body>`);
    res = await comms.send({ channel: 'email', to: r.address, subject, body, html, headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, leadId: r.lead_id, studentId: r.student_id, templateKey: `campaign:${c.slug}`.slice(0, 60), automated: true, locale: L });
  } else {
    const link = c.cta_url ? `\n${config.appUrl}/c/c/${r.token}` : '';
    const stop = L === 'ar' ? `\nلإلغاء الاشتراك: ${unsub}` : `\nUnsubscribe: ${unsub}`;
    res = await comms.send({ channel: c.channel, to: r.address, body: `${body}${link}${stop}`, leadId: r.lead_id, studentId: r.student_id, templateKey: `campaign:${c.slug}`.slice(0, 60), automated: true, locale: L });
  }
  await knex('campaign_recipients').where({ id: r.id }).update(res.sent ? { status: 'sent', sent_at: new Date(), error: null } : { status: 'failed', error: String(res.reason || 'failed').slice(0, 255) });
}

/** The sending job: due scheduled campaigns start; sending campaigns send the next batch. */
async function tick() {
  await knex('campaigns').where({ status: 'scheduled' }).where('scheduled_at', '<=', new Date()).update({ status: 'sending', started_at: new Date() });
  const active = await knex('campaigns').where({ status: 'sending' });
  for (const c of active) {
    const batch = await knex('campaign_recipients').where({ campaign_id: c.id, status: 'queued' }).orderBy('id').limit(BATCH); // eslint-disable-line no-await-in-loop
    for (const r of batch) await sendOne(c, r).catch((e) => knex('campaign_recipients').where({ id: r.id }).update({ status: 'failed', error: e.message.slice(0, 255) })); // eslint-disable-line no-await-in-loop
    const left = await knex('campaign_recipients').where({ campaign_id: c.id, status: 'queued' }).first('id'); // eslint-disable-line no-await-in-loop
    if (!left) await knex('campaigns').where({ id: c.id }).update({ status: 'sent', finished_at: new Date() }); // eslint-disable-line no-await-in-loop
  }
}
jobs.register('campaigns.send', 60_000, tick);

async function stats(id) {
  const [r] = await knex('campaign_recipients').where({ campaign_id: id }).select(
    knex.raw('COUNT(*) AS total'), knex.raw("SUM(status = 'sent') AS sent"), knex.raw("SUM(status = 'failed') AS failed"), knex.raw("SUM(status = 'skipped') AS skipped"), knex.raw("SUM(status = 'queued') AS queued"),
    knex.raw('SUM(opened_at IS NOT NULL) AS opened'), knex.raw('SUM(clicked_at IS NOT NULL) AS clicked'), knex.raw('SUM(unsubscribed_at IS NOT NULL) AS unsubscribed'),
  );
  const c = await knex('campaigns').where({ id }).first('started_at');
  // Replies: inbound messages from recipients after the campaign started. Conversions: leads who became students after it.
  const replied = c && c.started_at ? Number((await knex('messages as m').join('campaign_recipients as r', function on() { this.on('r.lead_id', 'm.lead_id').orOn('r.student_id', 'm.student_id'); }).where('r.campaign_id', id).where('m.direction', 'in').where('m.created_at', '>=', c.started_at).countDistinct({ n: 'r.id' }))[0].n) : 0;
  const converted = c && c.started_at ? Number((await knex('campaign_recipients as r').join('leads as l', 'l.id', 'r.lead_id').join('students as s', 's.id', 'l.student_id').where('r.campaign_id', id).where('s.created_at', '>=', c.started_at).count({ n: '*' }))[0].n) : 0;
  return Object.fromEntries([...Object.entries(r).map(([k, v]) => [k, Number(v || 0)]), ['replied', replied], ['converted', converted]]);
}

// Public endpoints' logic.
async function byToken(token) { return /^[A-Za-z0-9_-]{20,40}$/.test(String(token || '')) ? knex('campaign_recipients').where({ token }).first() : null; }
async function markOpen(token) { const r = await byToken(token); if (r && !r.opened_at) await knex('campaign_recipients').where({ id: r.id }).update({ opened_at: new Date() }); }
async function click(token) {
  const r = await byToken(token);
  if (!r) return null;
  const c = await knex('campaigns').where({ id: r.campaign_id }).first();
  await knex('campaign_recipients').where({ id: r.id }).update({ clicked_at: r.clicked_at || new Date(), opened_at: r.opened_at || new Date() });
  return c && c.cta_url ? withUtm(c.cta_url, c) : config.appUrl;
}
async function unsubscribe(token) {
  const r = await byToken(token);
  if (!r) return false;
  const now = new Date();
  if (r.lead_id) await knex('leads').where({ id: r.lead_id }).update({ consent_marketing: false, unsubscribed_at: now });
  if (r.student_id) await knex('students').where({ id: r.student_id }).update({ consent_marketing: false, unsubscribed_at: now });
  // Same address anywhere else in the CRM.
  const col = r.address.includes('@') ? 'email' : 'phone_tail';
  const val = r.address.includes('@') ? r.address : people.phoneTail(r.address);
  if (val) { await knex('leads').where(col, val).update({ consent_marketing: false, unsubscribed_at: now }); await knex('students').where(col, val).update({ consent_marketing: false, unsubscribed_at: now }); }
  if (r.subscriber_id) await require('../marketing/newsletter').unsubscribeSubscriber(r.subscriber_id); // eslint-disable-line global-require
  await require('../marketing/newsletter').unsubscribeEmail(r.address); // eslint-disable-line global-require
  await knex('campaign_recipients').where({ id: r.id }).update({ unsubscribed_at: r.unsubscribed_at || now });
  const activity = require('../crm/activity.service'); // eslint-disable-line global-require
  if (r.lead_id || r.student_id) await activity.log({ leadId: r.lead_id, studentId: r.student_id }, { type: 'system', title: 'unsubscribed', meta: { channel: col === 'email' ? 'email' : 'sms' } });
  await events.emit('marketing.unsubscribed', { recipientId: r.id });
  return true;
}

module.exports = { segmentFrom, audienceQuery, preview, launch, cancel, tick, stats, byToken, markOpen, click, unsubscribe, sendOne };
