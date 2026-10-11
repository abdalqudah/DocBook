// Platform admin → Sales → Templates (write a template with {placeholders}; make it for a customer) and → Documents
// (each with its customer link, edited, sent by e-mail or WhatsApp). Mounted inside admin/web.js after its guard.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const sales = require('./sales.service');
const tpl = require('./templates.service');
const uploads = require('../../core/uploads');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const multer = require('multer');

const router = express.Router();
const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: ['/css/site.css', '/css/admin.css'], ...data });
const base = (res) => res.locals.baseUrl || process.env.APP_URL || '';
const failMsg = (e) => (e.details ? Object.values(e.details).filter(Boolean).join(' ') : e.message);
const contactsFor = () => knex('crm_contacts').orderBy('updated_at', 'desc').limit(500).select('id', 'name', 'organization');
const userErr = (e) => e instanceof AppError && e.status < 500;

// ---------------------------------------------------------------- templates
router.get('/templates', wrap(async (req, res) => {
  const contact = req.query.contact ? await knex('crm_contacts').where({ id: Number(req.query.contact) || 0 }).first('id', 'name') : null;
  page(res, 'templates', { title: req.t('tpl.title'), rows: await tpl.list(), contact, csrfField: true });
}));
async function renderEditor(req, res, extra = {}) {
  const t = req.params.id ? await tpl.get(req.params.id) : null;
  page(res, 'template-form', { title: t ? t.name : req.t('tpl.new'), tp: t, fields: tpl.MAIN_FIELDS, icons: Object.keys(tpl.ICONS), iconMap: tpl.ICONS, errors: {}, old: null, ...extra });
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
// A Word file (.docx) as a new template, or replacing a Word template's file.
const wordUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 + 1, files: 1, fields: 8 } }).single('file');
const takeWord = (req, res, next) => wordUpload(req, res, (e) => { if (e) req.uploadError = e.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB.' : 'Choose a Word file (.docx).'; next(); });
router.post('/templates/upload', takeWord, verifyCsrfAfterUpload, wrap(async (req, res) => {
  try {
    if (req.uploadError) throw new AppError('VALIDATION_FAILED', req.uploadError, 422, { file: req.uploadError });
    const id = await tpl.saveDocx(req.ctx, null, req.file, req.body);
    flash(req, 'success', req.t('tpl.saved'));
    return res.redirect(`/admin/templates/${id}`);
  } catch (e) {
    if (!userErr(e)) throw e;
    flash(req, 'error', failMsg(e));
    return res.redirect('/admin/templates');
  }
}));
router.post('/templates/:id(\\d+)/file', takeWord, verifyCsrfAfterUpload, wrap(async (req, res) => {
  try {
    if (req.uploadError) throw new AppError('VALIDATION_FAILED', req.uploadError, 422, { file: req.uploadError });
    await tpl.saveDocx(req.ctx, req.params.id, req.file);
    flash(req, 'success', req.t('tpl.saved'));
  } catch (e) { if (!userErr(e)) throw e; flash(req, 'error', failMsg(e)); }
  res.redirect(`/admin/templates/${Number(req.params.id)}`);
}));
router.get('/templates/:id(\\d+)/download', wrap(async (req, res) => {
  const t = await tpl.get(req.params.id, { withFile: true });
  if (t.kind !== 'docx' || !t.file) return res.redirect(`/admin/templates/${t.id}`);
  return sendWord(res, t.file, t.filename || `${t.name}.docx`);
}));
// A picture for online templates → JSON { token, markup } (the editor inserts the markup where the cursor is).
const imageUpload = uploads.memory({ limits: { fileSize: 2 * 1024 * 1024 + 1, files: 1, fields: 4 }, maxSide: 1600 });
router.post('/templates/images', (req, res, next) => imageUpload.single('file')(req, res, (e) => { if (e) req.uploadError = e.code === 'LIMIT_FILE_SIZE' ? 'The picture is larger than 2 MB.' : 'Choose a picture (PNG, JPEG or WebP).'; next(); }),
  verifyCsrfAfterUpload, wrap(async (req, res) => {
    try {
      if (req.uploadError) throw new AppError('VALIDATION_FAILED', req.uploadError, 422, { file: req.uploadError });
      const token = await tpl.saveImage(req.ctx, req.file);
      return res.json({ ok: true, token, markup: `![](img:${token})` });
    } catch (e) {
      if (!userErr(e)) throw e;
      return res.status(422).json({ ok: false, error: failMsg(e) });
    }
  }));

function sendWord(res, buf, name) {
  res.set({ 'Content-Type': tpl.mimeOfFile(name), 'Content-Disposition': `${tpl.isPdfName(name) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  return res.end(buf);
}

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
  page(res, 'documents', { title: req.t('tpl.documents'), rows: await tpl.listDocuments(), contacts: await contactsFor() });
}));
async function renderDoc(req, res, extra = {}) {
  const doc = await sales.sendable('document', req.params.id, base(res), req.query.locale);
  page(res, 'document-show', { title: doc.label, doc, d: doc.document, html: tpl.render(doc.document.body), sends: await sales.sendsFor('document', doc.id), errors: {}, old: null, ...extra });
}
// A ready PDF (a presentation, a brochure) as a document with its own link and message.
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 + 1, files: 1, fields: 8 } }).single('file');
router.post('/documents/upload', (req, res, next) => pdfUpload(req, res, (e) => { if (e) req.uploadError = e.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 15 MB.' : 'Choose a PDF file.'; next(); }), verifyCsrfAfterUpload, wrap(async (req, res) => {
  try {
    if (req.uploadError) throw new AppError('VALIDATION_FAILED', req.uploadError, 422, { file: req.uploadError });
    const id = await tpl.uploadDocument(req.ctx, req.file, req.body);
    flash(req, 'success', req.t('tpl.uploaded'));
    return res.redirect(`/admin/documents/${id}`);
  } catch (e) {
    if (!userErr(e)) throw e;
    flash(req, 'error', failMsg(e));
    return res.redirect('/admin/documents');
  }
}));
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
router.get('/documents/:id(\\d+)/download', wrap(async (req, res) => {
  const d = await tpl.getDocument(req.params.id, { withFile: true });
  if (!d.file) return res.redirect(`/admin/documents/${d.id}`);
  return sendWord(res, d.file, d.filename);
}));
router.post('/documents/:id(\\d+)/delete', wrap(async (req, res) => {
  await tpl.removeDocument(req.ctx, req.params.id);
  flash(req, 'success', req.t('tpl.doc_deleted'));
  res.redirect('/admin/documents');
}));

module.exports = router;
