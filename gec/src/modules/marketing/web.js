// Staff marketing tools: newsletter subscribers (list, export, remove) and the UTM link builder with results.
const express = require('express');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const fmt = require('../../core/format');
const { toCsv } = require('../../core/csv');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah, idParam, page: pageNo } = require('../../core/http');
const { E } = require('../../core/errors');
const { validate, z } = require('../../core/validate');
const nav = require('../staff/nav');
const newsletter = require('./newsletter');

nav.add('communication', { key: 'subscribers', href: '/staff/subscribers', icon: 'mail', perms: ['campaigns.manage'] }, { before: 'templates' });
nav.add('communication', { key: 'utm', href: '/staff/utm', icon: 'link', perms: ['campaigns.manage', 'analytics.view'] }, { before: 'templates' });

const router = express.Router();
const STATUSES = ['confirmed', 'pending', 'unsubscribed'];

// ------------------------------------------------------------------ subscribers
const filtered = (q) => {
  const k = knex('newsletter_subscribers');
  if (STATUSES.includes(q.status)) k.where('status', q.status);
  if (q.q) k.where((w) => w.where('email', 'like', `%${String(q.q).slice(0, 100)}%`).orWhere('name', 'like', `%${String(q.q).slice(0, 100)}%`));
  return k;
};
router.get('/subscribers', can('campaigns.manage'), ah(async (req, res) => {
  const p = pageNo(req);
  const [{ n }] = await filtered(req.query).clone().count({ n: '*' });
  const rows = await filtered(req.query).orderBy('id', 'desc').limit(50).offset((p - 1) * 50);
  res.page('pages/staff/marketing/subscribers', { layout: 'staff', title: req.t('nav.subscribers'), rows, total: Number(n), pageNo: p, counts: await newsletter.counts(), q: req.query });
}));
router.get('/subscribers/export.csv', can('campaigns.manage'), ah(async (req, res) => {
  const rows = await filtered(req.query).orderBy('id').limit(50000);
  await audit.record(req.ctx, 'newsletter.exported', { entityType: 'newsletter_subscriber', newValues: { count: rows.length } });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="subscribers-${fmt.today()}.csv"` });
  res.send(toCsv(['email', 'name', 'locale', 'status', 'interests', 'degree', 'source', 'utm_source', 'utm_campaign', 'confirmed_at', 'unsubscribed_at', 'created_at'].map((key) => ({ key })), rows));
}));
router.post('/subscribers/:id/delete', can('campaigns.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  const s = await knex('newsletter_subscribers').where({ id }).first('id');
  if (!s) throw E.notFound();
  await knex('newsletter_subscribers').where({ id }).del();
  await audit.record(req.ctx, 'newsletter.deleted', { entityType: 'newsletter_subscriber', entityId: id });
  flash(req, 'ok', req.t('newsletter.deleted'));
  res.redirect('/staff/subscribers');
}));

// ------------------------------------------------------------------ UTM builder
const slug = (max) => z.string().trim().min(1, 'Required.').max(max).transform((v) => v.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_.\-]/g, '')).refine((v) => v.length > 0, 'Use letters, numbers, - or _.');
const optSlug = (max) => z.preprocess((v) => (v === '' ? undefined : v), slug(max).optional());
const schema = z.object({
  name: z.string().trim().min(2, 'Name the link.').max(160),
  url: z.string().trim().max(400).refine((v) => { try { const u = new URL(v, config.appUrl); return ['http:', 'https:'].includes(u.protocol); } catch { return false; } }, 'Enter a page address (e.g. /programs or https://…).'),
  utm_source: slug(120), utm_medium: slug(120), utm_campaign: slug(160), utm_term: optSlug(160), utm_content: optSlug(160),
});
const PRESETS = [
  { key: 'instagram', source: 'instagram', medium: 'social' }, { key: 'facebook', source: 'facebook', medium: 'social' }, { key: 'tiktok', source: 'tiktok', medium: 'social' },
  { key: 'linkedin', source: 'linkedin', medium: 'social' }, { key: 'whatsapp', source: 'whatsapp', medium: 'messaging' }, { key: 'google_ads', source: 'google', medium: 'cpc' },
  { key: 'meta_ads', source: 'meta', medium: 'paid_social' }, { key: 'email', source: 'newsletter', medium: 'email' }, { key: 'print', source: 'flyer', medium: 'offline' }, { key: 'event', source: 'event', medium: 'offline' },
];
function build(l) {
  const u = new URL(l.url, config.appUrl);
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((k) => { if (l[k]) u.searchParams.set(k, l[k]); });
  return u.toString();
}
async function withResults(rows) {
  return Promise.all(rows.map(async (l) => {
    const match = (q, p = '') => q.where(`${p}utm_source`, l.utm_source).where(`${p}utm_campaign`, l.utm_campaign).where(`${p}utm_medium`, l.utm_medium);
    const [[v], [ld], [st]] = await Promise.all([
      match(knex('visitors')).count({ n: '*' }), match(knex('leads')).count({ n: '*' }),
      match(knex('leads')).whereNotNull('student_id').count({ n: '*' }),
    ]);
    return { ...l, link: build(l), visitors: Number(v.n), leads: Number(ld.n), students: Number(st.n) };
  }));
}
router.get('/utm', can('campaigns.manage', 'analytics.view'), ah(async (req, res) => {
  const rows = await withResults(await knex('utm_links').orderBy('id', 'desc').limit(200));
  res.page('pages/staff/marketing/utm', { layout: 'staff', title: req.t('nav.utm'), rows, presets: PRESETS, appUrl: config.appUrl, errors: {}, old: { url: '/', utm_source: String(req.query.source || '').slice(0, 60), utm_medium: String(req.query.medium || '').slice(0, 60) } });
}));
router.post('/utm', can('campaigns.manage'), ah(async (req, res) => {
  try {
    const d = validate(schema, req.body);
    const u = new URL(d.url, config.appUrl);
    const url = u.origin === new URL(config.appUrl).origin ? `${u.pathname}${u.search}` : u.toString();
    const [id] = await knex('utm_links').insert({ ...d, url, utm_term: d.utm_term || null, utm_content: d.utm_content || null, created_by: req.user.id });
    await audit.record(req.ctx, 'utm.created', { entityType: 'utm_link', entityId: id, newValues: { name: d.name, campaign: d.utm_campaign } });
    flash(req, 'ok', req.t('utm.saved'));
    return res.redirect(`/staff/utm#utm-${id}`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return res.page('pages/staff/marketing/utm', { layout: 'staff', title: req.t('nav.utm'), rows: await withResults(await knex('utm_links').orderBy('id', 'desc').limit(200)), presets: PRESETS, appUrl: config.appUrl, errors: e.details, old: req.body });
  }
}));
router.post('/utm/:id/delete', can('campaigns.manage'), ah(async (req, res) => {
  await knex('utm_links').where({ id: idParam(req.params.id) }).del();
  flash(req, 'ok', req.t('common.deleted'));
  res.redirect('/staff/utm');
}));

module.exports = router;
