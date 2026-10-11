// Platform admin → Sales → Templates (write a template with {placeholders}; make it for a customer) and → Documents
// (each with its customer link, edited, sent by e-mail or WhatsApp). Mounted inside admin/web.js after its guard.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const sales = require('./sales.service');
const tpl = require('./templates.service');

const router = express.Router();
const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: ['/css/site.css', '/css/admin.css'], ...data });
const base = (res) => res.locals.baseUrl || process.env.APP_URL || '';
const failMsg = (e) => (e.details ? Object.values(e.details).filter(Boolean).join(' ') : e.message);
const contactsFor = () => knex('crm_contacts').orderBy('updated_at', 'desc').limit(500).select('id', 'name', 'organization');
const userErr = (e) => e instanceof AppError && e.status < 500;

// ---------------------------------------------------------------- templates
router.get('/templates', wrap(async (req, res) => {
  const contact = req.query.contact ? await knex('crm_contacts').where({ id: Number(req.query.contact) || 0 }).first('id', 'name') : null;
  page(res, 'templates', { title: req.t('tpl.title'), rows: await tpl.list(), contact });
}));
async function renderEditor(req, res, extra = {}) {
  const t = req.params.id ? await tpl.get(req.params.id) : null;
  page(res, 'template-form', { title: t ? t.name : req.t('tpl.new'), tp: t, fields: tpl.MAIN_FIELDS, errors: {}, old: null, ...extra });
}
router.get('/templates/new', wrap((req, res) => renderEditor(req, res)));
router.get('/templates/:id(\\d+)/edit', wrap((req, res) => renderEditor(req, res)));
router.post(['/templates/new', '/templates/:id(\\d+)/edit'], wrap(async (req, res) => {
  let id;
  try { id = await tpl.save(req.ctx, req.params.id, req.body); } catch (e) {
    if (!userErr(e)) throw e;
    res.status(422);
    return renderEditor(req, res, { errors: e.details || {}, old: req.body });
  }
  flash(req, 'success', req.t('tpl.saved'));
  return res.redirect(`/admin/templates/${id}`);
}));
async function renderUse(req, res, extra = {}) {
  const t = await tpl.get(req.params.id);
  const contact = req.query.contact || req.body.contact_id ? await knex('crm_contacts').where({ id: Number(req.query.contact || req.body.contact_id) || 0 }).first() : null;
  page(res, 'template-use', {
    title: t.name, tp: t, contact, contacts: await contactsFor(), values: await tpl.suggestions(t, contact), preview: tpl.render(t.body),
    made: await tpl.listDocuments().where('d.template_id', t.id).limit(20), errors: {}, old: null, ...extra,
  });
}
router.get('/templates/:id(\\d+)', wrap((req, res) => renderUse(req, res)));
router.post('/templates/:id(\\d+)/generate', wrap(async (req, res) => {
  let id;
  try { id = await tpl.generate(req.ctx, req.params.id, req.body); } catch (e) {
    if (!userErr(e)) throw e;
    res.status(422);
    return renderUse(req, res, { errors: e.details || {}, old: req.body, formError: failMsg(e) });
  }
  flash(req, 'success', req.t('tpl.generated'));
  return res.redirect(`/admin/documents/${id}`);
}));
router.post('/templates/:id(\\d+)/delete', wrap(async (req, res) => {
  await tpl.remove(req.ctx, req.params.id);
  flash(req, 'success', req.t('tpl.deleted'));
  res.redirect('/admin/templates');
}));

// ---------------------------------------------------------------- documents
router.get('/documents', wrap(async (req, res) => {
  page(res, 'documents', { title: req.t('tpl.documents'), rows: await tpl.listDocuments() });
}));
async function renderDoc(req, res, extra = {}) {
  const doc = await sales.sendable('document', req.params.id, base(res), req.query.locale);
  page(res, 'document-show', { title: doc.label, doc, d: doc.document, html: tpl.render(doc.document.body), sends: await sales.sendsFor('document', doc.id), errors: {}, old: null, ...extra });
}
router.get('/documents/:id(\\d+)', wrap((req, res) => renderDoc(req, res)));
router.post('/documents/:id(\\d+)', wrap(async (req, res) => {
  try { await tpl.updateDocument(req.ctx, req.params.id, req.body); } catch (e) {
    if (!userErr(e)) throw e;
    res.status(422);
    return renderDoc(req, res, { errors: e.details || {}, old: req.body });
  }
  flash(req, 'success', req.t('tpl.doc_saved'));
  return res.redirect(`/admin/documents/${Number(req.params.id)}`);
}));
router.post('/documents/:id(\\d+)/email', wrap(async (req, res) => {
  try { await sales.sendEmail(req.ctx, 'document', req.params.id, req.body, base(res)); flash(req, 'success', req.t('sales.sent_email')); } catch (e) {
    if (!(e instanceof AppError) || (e.status >= 500 && e.code !== 'SEND_FAILED')) throw e;
    flash(req, 'error', failMsg(e));
  }
  res.redirect(`/admin/documents/${Number(req.params.id)}`);
}));
router.post('/documents/:id(\\d+)/whatsapp', wrap(async (req, res) => {
  try { return res.json({ ok: true, href: await sales.whatsappLink(req.ctx, 'document', req.params.id, req.body, base(res)) }); } catch (e) {
    if (!userErr(e)) throw e;
    return res.status(422).json({ ok: false, error: failMsg(e) });
  }
}));
router.post('/documents/:id(\\d+)/delete', wrap(async (req, res) => {
  await tpl.removeDocument(req.ctx, req.params.id);
  flash(req, 'success', req.t('tpl.doc_deleted'));
  res.redirect('/admin/documents');
}));

module.exports = router;
