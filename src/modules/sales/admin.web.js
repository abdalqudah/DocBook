// Platform admin → Quotations (list, new, edit / revise, duplicate, send by e-mail or WhatsApp, the customer's answers
// and the conversation), → Services (the catalog ticked into quotations), → Seller details, → Invoices sent from the
// platform (share link, send), and → E-mail log. Mounted inside admin/web.js after its guard.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const sales = require('./sales.service');
const response = require('./response.service');

const router = express.Router();
const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: ['/css/site.css', '/css/admin.css'], ...data });
const base = (res) => res.locals.baseUrl || process.env.APP_URL || '';
const failMsg = (e) => (e.details ? Object.values(e.details).filter(Boolean).join(' ') : e.message);

// ---------------------------------------------------------------- dashboard
router.get('/sales-dashboard', wrap(async (req, res) => {
  page(res, 'sales-dashboard', { title: req.t('dash.title'), data: await require('./dashboard.service').overview(), countryName: (cc) => require('../settings/options').regionName(cc, req.locale) }); // eslint-disable-line global-require
}));

// ---------------------------------------------------------------- quotations
router.get('/quotes', wrap(async (req, res) => {
  const all = await sales.listQuotes();
  const state = String(req.query.state || '');
  page(res, 'quotes', { title: req.t('sales.quotes'), rows: state ? all.filter((q) => q.state === state) : all, sum: sales.quoteSummary(all), state });
}));

async function renderForm(req, res, extra = {}) {
  const q = req.params.id ? await sales.getQuote(req.params.id) : null;
  const contact = !q && req.query.contact ? await knex('crm_contacts').where({ id: Number(req.query.contact) || 0 }).first() : null; // its country sets the VAT and currency
  page(res, 'quote-form', {
    title: q ? q.number : req.t('sales.new_quote'), q, contact, p: await sales.profile(), services: await sales.listServices({ activeOnly: true }),
    contacts: await knex('crm_contacts').orderBy('name').limit(1000).select('id', 'name', 'organization', 'email', 'phone', 'whatsapp', 'country'),
    revise: Boolean(q && q.status !== 'draft'), errors: {}, old: null, ...extra,
  });
}
const formRun = (fn) => wrap(async (req, res) => {
  try { return await fn(req, res); } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    res.status(e.status === 409 ? 409 : 422);
    return renderForm(req, res, { errors: e.details || {}, old: req.body, formError: e.details ? null : e.message });
  }
});
router.get('/quotes/new', wrap((req, res) => renderForm(req, res)));
router.post('/quotes/new', formRun(async (req, res) => {
  const id = await sales.createQuote(req.ctx, req.body);
  flash(req, 'success', req.t('sales.quote_saved'));
  res.redirect(`/admin/quotes/${id}`);
}));
router.get('/quotes/:id(\\d+)/edit', wrap((req, res) => renderForm(req, res)));
router.post('/quotes/:id(\\d+)/edit', formRun(async (req, res) => {
  const q = await sales.getQuote(req.params.id);
  await sales.updateQuote(req.ctx, q.id, req.body, { revised: q.status !== 'draft' });
  flash(req, 'success', req.t(q.status !== 'draft' ? 'sales.quote_revised' : 'sales.quote_saved'));
  res.redirect(`/admin/quotes/${q.id}`);
}));

async function renderShow(req, res, extra = {}) {
  const q = await sales.getQuote(req.params.id);
  const doc = await sales.sendable('quote', q.id, base(res), req.query.locale);
  const contact = q.contact_id ? await knex('crm_contacts').where({ id: q.contact_id }).first('id', 'business_id') : null;
  const plans = q.status === 'accepted' && contact && contact.business_id ? await require('../subscriptions/subscriptions.service').listPlans({ activeOnly: true, publicOnly: true }) : []; // eslint-disable-line global-require
  page(res, 'quote-show', {
    contact, plans,
    title: q.number, q, state: sales.quoteState(q), doc, p: await sales.profile(), events: await sales.events(q.id), sends: await sales.sendsFor('quote', q.id),
    reasons: response.DECLINE_REASONS, errors: {}, ...extra,
  });
}
router.get('/quotes/:id(\\d+)', wrap((req, res) => renderShow(req, res)));

const act = (fn, okKey, to) => wrap(async (req, res) => {
  try { await fn(req, res); flash(req, 'success', req.t(okKey)); } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 && e.code !== 'SEND_FAILED') throw e;
    flash(req, 'error', failMsg(e));
  }
  res.redirect(to ? to(req) : `/admin/quotes/${req.params.id}`);
});
// An accepted quotation → the clinic's subscription: the plan chosen here issues its invoice (e-mailed with its link);
// a customer without an account yet gets a sign-up invitation by e-mail.
router.post('/quotes/:id(\\d+)/activate', act(async (req) => {
  const q = await sales.getQuote(req.params.id);
  const c = q.contact_id ? await knex('crm_contacts').where({ id: q.contact_id }).first('business_id') : null;
  const business = c && c.business_id ? await knex('businesses').where({ id: c.business_id }).first('id', 'name', 'timezone', 'currency') : null;
  if (q.status !== 'accepted' || !business) throw new AppError('QUOTE_NOT_READY', 'The quotation must be accepted, and its customer signed up.', 409);
  const subs = require('../subscriptions/subscriptions.service'); // eslint-disable-line global-require
  const invId = await subs.choosePlan({ ...req.ctx, businessId: null }, business, req.body);
  await knex('quote_events').insert({ quote_id: q.id, type: 'activated', by: 'team', user_id: req.ctx.userId || null, revision: q.revision, message: `invoice:${invId}` });
  await require('../crm/crm.service').log(req.ctx, q.contact_id, 'invoice', `${q.number} → invoice #${invId}`).catch(() => {}); // eslint-disable-line global-require
}, 'sales.activated'));
router.post('/quotes/:id(\\d+)/invite', act(async (req, res) => {
  const q = await sales.getQuote(req.params.id);
  if (!q.customer_email) throw new AppError('NO_EMAIL', 'The quotation has no customer e-mail.', 422);
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  const { translator } = require('../../core/i18n'); // eslint-disable-line global-require
  const t = translator(q.locale === 'en' ? 'en' : 'ar');
  const link = `${String(base(res)).replace(/\/+$/, '')}/signup?email=${encodeURIComponent(q.customer_email)}`;
  const subject = t('sales.invite_subject', { brand: res.locals.brandName });
  const sent = await mailer.send({ kind: 'invite', to: q.customer_email, subject, html: mailer.layout({ locale: q.locale, title: subject, body: t('sales.invite_body', { name: q.customer_name, number: q.number }), cta: t('sales.invite_cta'), href: link }) });
  if (!sent) throw new AppError('SEND_FAILED', 'The platform e-mail is not set up (Admin → Settings).', 502);
  await knex('quote_events').insert({ quote_id: q.id, type: 'invited', by: 'team', user_id: req.ctx.userId || null, revision: q.revision });
}, 'sales.invited'));
router.post('/quotes/:id(\\d+)/email', act((req, res) => sales.sendEmail(req.ctx, 'quote', req.params.id, req.body, base(res)), 'sales.sent_email'));
// WhatsApp: the page fetches the wa.me link as JSON (a form may not redirect to another site under the CSP).
router.post('/quotes/:id(\\d+)/whatsapp', wrap(async (req, res) => {
  try { return res.json({ ok: true, href: await sales.whatsappLink(req.ctx, 'quote', req.params.id, req.body, base(res)) }); } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    return res.status(422).json({ ok: false, error: failMsg(e) });
  }
}));
router.post('/quotes/:id(\\d+)/reply', act((req) => response.reply(req.ctx, req.params.id, req.body.message), 'sales.reply_sent'));
router.post('/quotes/:id(\\d+)/mark-sent', act(async (req) => { await knex('quotes').where({ id: Number(req.params.id), status: 'draft' }).update({ status: 'sent', sent_at: new Date() }); }, 'sales.marked_sent'));
router.post('/quotes/:id(\\d+)/duplicate', wrap(async (req, res) => {
  const id = await sales.duplicateQuote(req.ctx, req.params.id);
  flash(req, 'success', req.t('sales.duplicated'));
  res.redirect(`/admin/quotes/${id}/edit`);
}));
router.post('/quotes/:id(\\d+)/delete', act((req) => sales.removeQuote(req.ctx, req.params.id), 'sales.deleted', () => '/admin/quotes'));

// ---------------------------------------------------------------- services catalog
router.get('/sales-services', wrap(async (req, res) => {
  page(res, 'sales-services', { title: req.t('sales.services'), rows: await sales.listServices(), edit: req.query.edit ? await knex('sales_services').where({ id: Number(req.query.edit) || 0 }).first() : null, errors: {}, old: null });
}));
router.post('/sales-services', act(async (req) => { await sales.saveService(req.ctx, req.body.id, req.body); }, 'sales.service_saved', () => '/admin/sales-services'));
router.post('/sales-services/:id(\\d+)/delete', act(async (req) => { await sales.removeService(req.ctx, req.params.id); }, 'sales.service_removed', () => '/admin/sales-services'));

// ---------------------------------------------------------------- seller details
async function renderProfile(req, res, extra = {}) {
  page(res, 'sales-profile', { title: req.t('sales.profile'), p: await sales.profile(), fields: sales.PROFILE_FIELDS, countryName: (cc) => require('../settings/options').regionName(cc, req.locale), errors: {}, old: null, ...extra }); // eslint-disable-line global-require
}
router.get('/sales-profile', wrap((req, res) => renderProfile(req, res)));
router.post('/sales-profile', wrap(async (req, res) => {
  try { await sales.saveProfile(req.ctx, req.body); } catch (e) {
    if (!(e instanceof AppError) || !e.details) throw e;
    res.status(422);
    return renderProfile(req, res, { errors: e.details, old: req.body });
  }
  flash(req, 'success', req.t('sales.profile_saved'));
  return res.redirect('/admin/sales-profile');
}));

// ---------------------------------------------------------------- the platform's subscription invoices: link and send
router.get('/sales-invoices', wrap(async (req, res) => {
  const rows = await knex('platform_invoices as i').join('businesses as b', 'b.id', 'i.business_id').whereNot('i.status', 'void')
    .orderBy('i.id', 'desc').limit(300).select('i.*', 'b.name as clinic_name', 'b.country as clinic_country');
  page(res, 'sales-invoices', { title: req.t('sales.invoices'), rows });
}));
router.get('/sales-invoices/:id(\\d+)', wrap(async (req, res) => {
  const doc = await sales.sendable('invoice', req.params.id, base(res), req.query.locale);
  page(res, 'sales-invoice-show', { title: doc.label, doc, inv: doc.invoice, sends: await sales.sendsFor('invoice', doc.id) });
}));
router.post('/sales-invoices/:id(\\d+)/email', act((req, res) => sales.sendEmail(req.ctx, 'invoice', req.params.id, req.body, base(res)), 'sales.sent_email', (req) => `/admin/sales-invoices/${req.params.id}`));
router.post('/sales-invoices/:id(\\d+)/whatsapp', wrap(async (req, res) => {
  try { return res.json({ ok: true, href: await sales.whatsappLink(req.ctx, 'invoice', req.params.id, req.body, base(res)) }); } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    return res.status(422).json({ ok: false, error: failMsg(e) });
  }
}));

// ---------------------------------------------------------------- e-mail log
router.get('/email-log', wrap(async (req, res) => {
  const q = knex('email_log').orderBy('id', 'desc').limit(300);
  if (['sent', 'failed', 'not_sent'].includes(req.query.status)) q.where('status', req.query.status);
  if (req.query.q) q.where('to_addr', 'like', `%${String(req.query.q).replace(/[\\%_]/g, (c) => `\\${c}`).slice(0, 100)}%`);
  page(res, 'email-log', { title: req.t('sales.email_log'), rows: await q, f: { status: req.query.status || '', q: req.query.q || '' } });
}));

module.exports = router;
