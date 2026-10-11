// Platform admin → CRM: contacts (clinics, warehouses, reps, prospects) with their stage and next follow-up, and
// each contact's timeline — notes, calls, e-mails and WhatsApp messages sent from the platform. Mounted in admin/web.js.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, flash } = require('../../routes/helpers');
const { AppError, E } = require('../../core/errors');
const crm = require('./crm.service');

const router = express.Router();
const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: ['/css/site.css', '/css/admin.css'], ...data });
const options = () => require('../settings/options'); // eslint-disable-line global-require
const countryName = (locale) => (cc) => (cc ? options().regionName(cc, locale) : '—');

/** wa.me link to a contact with a short greeting (opens WhatsApp on the admin's phone / computer). */
function waLink(c, req) {
  const ch = require('../messaging/channels'); // eslint-disable-line global-require
  const to = ch.msisdn(c.whatsapp || c.phone, { JO: '962', SA: '966', AE: '971', KW: '965', QA: '974', BH: '973', OM: '968', EG: '20', IQ: '964', PS: '970', LB: '961', SY: '963' }[c.country] || '962');
  return to ? ch.waMeLink(to, req.t('crm.wa_greeting', { name: c.name })) : null;
}

router.get('/crm', wrap(async (req, res) => {
  await crm.sync(); // clinics and warehouses that signed up since the last visit
  const f = { q: String(req.query.q || '').slice(0, 80), kind: req.query.kind, stage: req.query.stage, country: String(req.query.country || '').toUpperCase(), due: req.query.due };
  const [rows, sum] = await Promise.all([crm.list(f), crm.summary()]);
  page(res, 'crm', { title: req.t('crm.title'), rows, sum, f, kinds: crm.KINDS, stages: crm.STAGES, countryName: countryName(req.locale), now: new Date() });
}));

// The pipeline as a board: a column per stage, cards dragged between them (or moved with the card's menu on a phone).
router.get('/crm/board', wrap(async (req, res) => {
  await crm.sync();
  const f = { q: String(req.query.q || '').slice(0, 80), kind: req.query.kind, country: String(req.query.country || '').toUpperCase() };
  const [rows, sum] = await Promise.all([crm.list(f), crm.summary()]);
  const ids = rows.map((r) => r.id);
  const open = ids.length ? await knex('quotes').whereIn('contact_id', ids).whereIn('status', ['sent', 'negotiating']).groupBy('contact_id', 'currency').select('contact_id', 'currency').sum({ total: 'total' }).count({ n: '*' }) : [];
  const quotes = {}; open.forEach((o) => { (quotes[o.contact_id] = quotes[o.contact_id] || []).push(o); });
  const columns = crm.STAGES.map((k) => ({ key: k, rows: rows.filter((r) => r.stage === k) }));
  page(res, 'crm-board', { title: req.t('crm.board'), columns, quotes, sum, f, kinds: crm.KINDS, stages: crm.STAGES, countryName: countryName(req.locale), now: new Date(), pageScripts: ['/js/crm-board.js'] });
}));

async function renderForm(req, res, extra = {}) {
  const c = req.params.id ? await crm.get(req.params.id) : null;
  page(res, 'crm-form', {
    title: c ? c.name : req.t('crm.new'), c, kinds: crm.KINDS, stages: crm.STAGES, sources: crm.SOURCES,
    countries: options().countryOptions(req.locale), errors: {}, old: null, ...extra,
  });
}
const formRun = (fn) => wrap(async (req, res) => {
  try { return await fn(req, res); } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || !e.details) throw e;
    res.status(422);
    return renderForm(req, res, { errors: e.details, old: req.body });
  }
});
router.get('/crm/new', wrap((req, res) => renderForm(req, res)));
router.post('/crm/new', formRun(async (req, res) => {
  const id = await crm.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('crm.saved'));
  res.redirect(`/admin/crm/${id}`);
}));
router.get('/crm/:id(\\d+)/edit', wrap((req, res) => renderForm(req, res)));
router.post('/crm/:id(\\d+)/edit', formRun(async (req, res) => {
  await crm.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('crm.saved'));
  res.redirect(`/admin/crm/${req.params.id}`);
}));

async function renderShow(req, res, extra = {}) {
  const c = await crm.get(req.params.id);
  const comms = await require('../platformcomms/comms.service').get(); // eslint-disable-line global-require
  const quotes = await require('../sales/sales.service').listQuotes({ contactId: c.id }); // eslint-disable-line global-require
  page(res, 'crm-show', {
    quotes,
    title: c.name, c, wa: waLink(c, req), waApi: comms.whatsapp.ready, mailReady: comms.mail.ready || Boolean(process.env.SMTP_HOST),
    stages: crm.STAGES, countryName: countryName(req.locale), errors: {}, old: null, ...extra,
  });
}
router.get('/crm/:id(\\d+)', wrap((req, res) => renderShow(req, res)));
const wantsJson = (req) => /application\/json/.test(req.get('accept') || '');
const act = (fn, okKey) => wrap(async (req, res) => {
  try {
    const r = await fn(req);
    if (wantsJson(req)) return res.json({ ok: !(r && r.ok === false), error: r && r.error ? r.error : undefined });
    if (r && r.ok === false) flash(req, 'error', `${req.t('crm.wa_failed')} ${r.error || ''}`.trim());
    else flash(req, 'success', req.t(okKey));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    if (wantsJson(req)) return res.status(422).json({ ok: false, error: e.details ? Object.values(e.details).filter(Boolean).join(' ') : e.message });
    flash(req, 'error', e.details ? Object.values(e.details).filter(Boolean).join(' ') : e.message);
  }
  return res.redirect(`/admin/crm/${req.params.id}`);
});
router.post('/crm/:id(\\d+)/note', act((req) => crm.log(req.ctx, Number(req.params.id), ['note', 'call', 'meeting'].includes(req.body.kind) ? req.body.kind : 'note', req.body.body), 'crm.logged'));
router.post('/crm/:id(\\d+)/follow-up', act((req) => crm.followUp(req.ctx, Number(req.params.id), { at: req.body.at, text: req.body.text }), 'crm.follow_saved'));
router.post('/crm/:id(\\d+)/stage', act(async (req) => {
  if (!crm.STAGES.includes(req.body.stage)) throw E.validation({ stage: 'Choose a valid value.' });
  const c = await crm.get(req.params.id);
  return crm.save(req.ctx, c.id, { ...c, next_action_at: c.next_action_at ? new Date(c.next_action_at).toISOString().slice(0, 16) : '', stage: req.body.stage });
}, 'crm.saved'));
router.post('/crm/:id(\\d+)/email', act((req) => crm.email(req.ctx, Number(req.params.id), req.body, req.locale), 'crm.email_sent'));
router.post('/crm/:id(\\d+)/whatsapp', act((req) => crm.whatsapp(req.ctx, Number(req.params.id), req.body.wa_text), 'crm.wa_sent'));
// "Opened WhatsApp": the admin sent it from the app on their phone — kept on the timeline.
router.post('/crm/:id(\\d+)/wa-opened', act((req) => crm.log(req.ctx, Number(req.params.id), 'whatsapp', req.t('crm.wa_opened_note')), 'crm.logged'));
router.post('/crm/:id(\\d+)/delete', wrap(async (req, res) => {
  await crm.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('crm.deleted'));
  res.redirect('/admin/crm');
}));

module.exports = router;
