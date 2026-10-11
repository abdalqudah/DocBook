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
// ---------------------------------------------------------------- find clinics on Google (leads.service)
const leads = require('./leads.service');
// Back to the finder page the admin was on (its filters kept); only a path on this site, never another address.
const finderBack = (req) => { try { const u = new URL(req.get('referer') || '', 'http://x'); return /^\/admin\/crm\/finder$/.test(u.pathname) ? u.pathname + u.search : '/admin/crm/finder'; } catch { return '/admin/crm/finder'; } };
const leadAct = (fn, back = finderBack) => wrap(async (req, res) => {
  try {
    const msg = await fn(req);
    if (msg) flash(req, 'success', msg);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', e.details ? Object.values(e.details).filter(Boolean).join(' ') : e.message);
  }
  res.redirect(back(req));
});
router.get('/crm/finder', wrap(async (req, res) => {
  const f = { search: Number(req.query.search) || null, status: leads.STATUSES.includes(req.query.status) ? req.query.status : 'new', fresh: req.query.fresh === '1' ? '1' : '', q: String(req.query.q || '').slice(0, 80) };
  const [cfg, searches, rows, n] = await Promise.all([leads.settings(), leads.searches(), leads.list(f), leads.counts()]);
  page(res, 'crm-finder', { title: req.t('crmf.title'), cfg, searches, rows, n, f, countries: options().countryOptions(req.locale), countryName: countryName(req.locale) });
}));
router.post('/crm/finder/settings', leadAct(async (req) => { await leads.saveSettings(req.ctx, req.body); return req.t('crmf.settings_saved'); }));
router.post('/crm/finder/searches', leadAct(async (req) => {
  const id = await leads.saveSearch(req.ctx, req.body);
  const r = await leads.run(req.ctx, id, { locale: req.locale });
  return req.t('crmf.ran', { found: r.found, added: r.added, fresh: r.fresh });
}, () => '/admin/crm/finder'));
router.post('/crm/finder/searches/:id(\\d+)/run', leadAct(async (req) => { const r = await leads.run(req.ctx, Number(req.params.id), { locale: req.locale }); return req.t('crmf.ran', { found: r.found, added: r.added, fresh: r.fresh }); }));
router.post('/crm/finder/searches/:id(\\d+)/auto', leadAct(async (req) => { await leads.setAuto(req.ctx, Number(req.params.id), req.body.auto === '1'); return req.t('crmf.saved'); }));
router.post('/crm/finder/searches/:id(\\d+)/delete', leadAct(async (req) => { await leads.removeSearch(req.ctx, Number(req.params.id)); return req.t('crmf.search_deleted'); }, () => '/admin/crm/finder'));
router.post('/crm/finder/leads', leadAct(async (req) => {
  if (req.body.do === 'ignore') return req.t('crmf.ignored', { n: await leads.ignore(req.ctx, req.body.lead) });
  const r = await leads.addToCrm(req.ctx, req.body.lead);
  return req.t('crmf.added', { places: r.places, contacts: r.contacts });
}));

// Bulk e-mail: campaigns to chosen contacts, so many an hour and a day.
const campaigns = require('./campaigns.service');
const campAct = (fn, back) => leadAct(fn, back);
const campBack = (req) => `/admin/crm/campaigns/${Number(req.params.id) || ''}`;
const audienceFilter = (q) => ({ q: String(q.q || '').slice(0, 80), kind: q.kind, stage: q.stage, country: String(q.country || '').toUpperCase().slice(0, 2), source: q.source });
router.get('/crm/campaigns', wrap(async (req, res) => {
  const [rows, limits] = await Promise.all([campaigns.list(), campaigns.settings()]);
  page(res, 'crm-campaigns', { title: req.t('camp.title'), rows, limits });
}));
router.post('/crm/campaigns/settings', campAct(async (req) => { await campaigns.saveSettings(req.ctx, req.body); return req.t('camp.limits_saved'); }, () => '/admin/crm/campaigns'));
const campForm = (req, res, c, extra = {}) => page(res, 'crm-campaign-form', { title: c ? c.name : req.t('camp.new'), c, limits: extra.limits, errors: extra.errors || {}, old: extra.old || null });
router.get('/crm/campaigns/new', wrap(async (req, res) => campForm(req, res, null, { limits: await campaigns.settings() })));
router.post('/crm/campaigns/new', wrap(async (req, res) => {
  try {
    const id = await campaigns.create(req.ctx, req.body);
    flash(req, 'success', req.t('camp.created'));
    res.redirect(`/admin/crm/campaigns/${id}`);
  } catch (e) {
    if (!(e instanceof AppError) || !e.details) throw e;
    res.status(422); campForm(req, res, null, { limits: await campaigns.settings(), errors: e.details, old: req.body });
  }
}));
router.get('/crm/campaigns/:id(\\d+)', wrap(async (req, res) => {
  const c = await campaigns.get(req.params.id);
  const f = audienceFilter(req.query);
  const people = campaigns.editable(c) ? await campaigns.audience(f, 1000) : [];
  page(res, 'crm-campaign', { title: c.name, c, f, people, limits: await campaigns.settings(), kinds: crm.KINDS, stages: crm.STAGES, sources: crm.SOURCES,
    countries: options().countryOptions(req.locale), editable: campaigns.editable(c), me: req.user && req.user.email });
}));
router.get('/crm/campaigns/:id(\\d+)/edit', wrap(async (req, res) => campForm(req, res, await campaigns.get(req.params.id), { limits: await campaigns.settings() })));
router.post('/crm/campaigns/:id(\\d+)/edit', wrap(async (req, res) => {
  try {
    await campaigns.update(req.ctx, req.params.id, req.body);
    flash(req, 'success', req.t('camp.saved'));
    res.redirect(campBack(req));
  } catch (e) {
    if (!(e instanceof AppError) || !e.details) throw e;
    res.status(422); campForm(req, res, await campaigns.get(req.params.id), { limits: await campaigns.settings(), errors: e.details, old: req.body });
  }
}));
router.post('/crm/campaigns/:id(\\d+)/recipients', campAct(async (req) => { const r = await campaigns.addRecipients(req.ctx, req.params.id, req.body); return req.t('camp.added', { added: r.added, skipped: r.skipped }); }, campBack));
router.post('/crm/campaigns/:id(\\d+)/recipients/clear', campAct(async (req) => req.t('camp.cleared', { n: await campaigns.clearQueued(req.ctx, req.params.id) }), campBack));
router.post('/crm/campaigns/:id(\\d+)/test', campAct(async (req) => { await campaigns.testSend(req.ctx, req.params.id, req.body.test_to); return req.t('camp.test_sent', { to: req.body.test_to }); }, campBack));
['start', 'pause', 'cancel'].forEach((action) => {
  router.post(`/crm/campaigns/:id(\\d+)/${action}`, campAct(async (req) => { await campaigns.setStatus(req.ctx, req.params.id, action); return req.t(`camp.did_${action}`); }, campBack));
});
router.post('/crm/campaigns/:id(\\d+)/delete', campAct(async (req) => { await campaigns.remove(req.ctx, req.params.id); return req.t('camp.deleted'); }, () => '/admin/crm/campaigns'));

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
  const docs = await require('../sales/templates.service').listDocuments({ contactId: c.id }); // eslint-disable-line global-require
  const insights = require('./insights.service'); // eslint-disable-line global-require
  const aiOn = (await require('../ai/ai.service').platformSettings()).active; // eslint-disable-line global-require
  page(res, 'crm-show', {
    quotes, docs, aiOn, aiSummary: insights.read(c),
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
// AI summary of the contact (the platform's AI settings): kept on the contact, shown on its page.
router.post('/crm/:id(\\d+)/ai-summary', wrap(async (req, res) => {
  try {
    await require('./insights.service').summarize(req.ctx, Number(req.params.id), req.locale); // eslint-disable-line global-require
    flash(req, 'success', req.t('crm.ai_done'));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    const k = `errors_ai.${e.code}`; const msg = req.t(k, { brand: res.locals.brandName });
    flash(req, 'error', msg !== k ? msg : req.t('errors_ai.AI_API_ERROR'));
  }
  res.redirect(`/admin/crm/${Number(req.params.id)}#ai`);
}));
router.post('/crm/:id(\\d+)/delete', wrap(async (req, res) => {
  await crm.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('crm.deleted'));
  res.redirect('/admin/crm');
}));

module.exports = router;
