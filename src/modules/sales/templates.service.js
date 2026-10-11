// Document templates for the sales team: text with {placeholders} (an agreement, an offer letter, a welcome pack).
// "Make for a customer" fills the placeholders (company, person, date, our name…, plus any field of the template's
// own), saves the result as a document with its own link (view / print / PDF) that is sent by e-mail or WhatsApp
// and kept on the CRM contact. Two kinds: a template written here — plain text with "# " heading, "## " sub-heading,
// "- " list, **bold**, [text](https://…) links, ![](img:…) pictures and [icon:whatsapp](https://…) linked icons (the
// page escapes everything first, so a template can never inject markup) — or a Word file (.docx) whose pictures,
// icons, links and styles are kept as they are while its {placeholders} are filled; the customer downloads it.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { randomToken } = require('../../core/tokens');
const { formatDate } = require('../../core/format');
const { E } = require('../../core/errors');
const sales = require('./sales.service');
const docx = require('../../core/docx');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCX_MAX = 10 * 1024 * 1024;
const COLS = ['id', 'name', 'locale', 'body', 'active', 'kind', 'filename', 'created_by', 'created_at', 'updated_at'];
/** Icons a template may link ([icon:name](url)) → the icon drawn. */
const ICONS = { whatsapp: 'message-circle', facebook: 'facebook', instagram: 'instagram', linkedin: 'linkedin', youtube: 'youtube', x: 'twitter', website: 'globe', link: 'link', phone: 'phone', email: 'mail', location: 'map-pin', calendar: 'calendar' };

const str = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const PH = () => /\{([\p{L}\p{N}_]{1,40})\}/gu;
const crm = () => require('../crm/crm.service'); // eslint-disable-line global-require

/** Placeholders filled automatically (English and Arabic names). */
const KNOWN = {
  company_name: 'company', 'اسم_الشركة': 'company', 'اسم_العيادة': 'company',
  customer_name: 'name', 'اسم_العميل': 'name',
  customer_email: 'email', 'البريد': 'email',
  customer_phone: 'phone', 'الجوال': 'phone',
  date: 'date', 'التاريخ': 'date',
  seller_name: 'seller', 'اسم_شركتنا': 'seller',
};
const MAIN_FIELDS = ['company_name', 'customer_name', 'customer_email', 'customer_phone', 'date', 'seller_name'];
const fieldsOf = (body) => [...new Set([...String(body || '').matchAll(PH())].map((m) => m[1]))];

async function list() {
  const rows = await knex('document_templates as t').leftJoin('sales_documents as d', 'd.template_id', 't.id')
    .groupBy('t.id').select(COLS.map((c) => `t.${c}`)).count({ uses: 'd.id' }).orderBy('t.active', 'desc').orderBy('t.id', 'desc');
  return rows.map((r) => ({ ...r, uses: Number(r.uses), fields: fieldsOf(r.body) }));
}
async function get(id, { withFile = false } = {}) {
  const t = await knex('document_templates').where({ id: Number(id) || 0 }).first(withFile ? [...COLS, 'file'] : COLS);
  if (!t) throw E.notFound('Template');
  return { ...t, fields: fieldsOf(t.body) };
}
async function save(ctx, id, body) {
  const v = { name: str(body.name, 150), locale: body.locale === 'en' ? 'en' : 'ar', body: String(body.body || '').replace(/\r\n/g, '\n').trim().slice(0, 60000), active: [].concat(body.active ?? '1').map(String).includes('1') };
  const errors = {};
  const cur0 = Number(id) ? await knex('document_templates').where({ id: Number(id) }).first('kind') : null;
  if (!v.name) errors.name = 'Enter a name.';
  if (!v.body && !(cur0 && cur0.kind === 'docx')) errors.body = 'Write the document.';
  if (Object.keys(errors).length) throw E.validation(errors);
  let tid = Number(id) || null;
  if (tid) {
    const cur = await get(tid);
    if (cur.kind === 'docx') { delete v.body; delete errors.body; }
    await knex('document_templates').where({ id: tid }).update({ ...v, updated_at: new Date() });
  } else [tid] = await knex('document_templates').insert({ ...v, created_by: ctx.userId || null });
  await audit.record(ctx, 'platform.template_saved', { entityType: 'document_template', entityId: tid, newValues: { name: v.name } });
  return tid;
}
/** A Word file (.docx) as a template (new, or replacing a Word template's file): its placeholders are read from it. */
async function saveDocx(ctx, id, file, body = {}) {
  const buf = file && file.buffer;
  if (!buf || !buf.length) throw E.validation({ file: 'Choose a file.' });
  if (buf.length > DOCX_MAX) throw E.validation({ file: 'The file is larger than 10 MB.' });
  const fields = String(file.originalname || '').toLowerCase().endsWith('.docx') ? docx.placeholders(buf) : null;
  if (!fields) throw E.validation({ file: 'Upload a Word document (.docx). Older .doc files: open them in Word and "Save as" .docx.' });
  const v = { kind: 'docx', file: buf, filename: str(file.originalname, 200), body: docx.text(buf).slice(0, 60000) || '—' };
  let tid = Number(id) || null;
  if (tid) {
    const t = await get(tid);
    if (t.kind !== 'docx') throw E.notFound('Template');
    await knex('document_templates').where({ id: tid }).update({ ...v, updated_at: new Date() });
  } else {
    const name = str(body.name, 150) || str(String(file.originalname).replace(/\.docx$/i, ''), 150);
    [tid] = await knex('document_templates').insert({ ...v, name, locale: body.locale === 'en' ? 'en' : 'ar', created_by: ctx.userId || null });
  }
  await audit.record(ctx, 'platform.template_saved', { entityType: 'document_template', entityId: tid, newValues: { kind: 'docx', file: v.filename, fields } });
  return tid;
}

/** A picture for online templates (already made small by the upload) → its token, used as ![](img:token). */
async function saveImage(ctx, file) {
  if (!file || !file.buffer || !/^image\/(png|jpeg|webp|gif)$/.test(file.mimetype || '')) throw E.validation({ file: 'Choose a picture (PNG, JPEG or WebP).' });
  if (file.buffer.length > 2 * 1024 * 1024) throw E.validation({ file: 'The picture is larger than 2 MB.' });
  const token = randomToken(18).replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || randomToken(12);
  await knex('template_images').insert({ token, mime: file.mimetype, data: file.buffer, name: str(file.originalname, 200), created_by: ctx.userId || null });
  return token;
}
const imageByToken = (token) => (/^[A-Za-z0-9]{8,64}$/.test(String(token || '')) ? knex('template_images').where({ token }).first('mime', 'data') : null);

/** Documents already made keep their own text. */
async function remove(ctx, id) {
  const t = await get(id);
  await knex('document_templates').where({ id: t.id }).del();
  await audit.record(ctx, 'platform.template_deleted', { entityType: 'document_template', entityId: t.id, oldValues: { name: t.name } });
}

/** Suggested values for one customer: the CRM contact, today's date, our name. */
async function suggestions(t, contact) {
  const p = await sales.profile();
  const src = {
    company: contact ? contact.organization || contact.name : '', name: contact ? contact.name : '', email: contact ? contact.email || '' : '',
    phone: contact ? contact.whatsapp || contact.phone || '' : '', date: formatDate(new Date(), t.locale, { dateStyle: 'long' }), seller: sales.sellerName(p, t.locale),
  };
  return Object.fromEntries(t.fields.map((f) => [f, KNOWN[f] ? src[KNOWN[f]] : '']));
}

/** Fills the template for one customer → the new document's id. */
async function generate(ctx, id, body) {
  const t = await get(id, { withFile: true });
  const names = [].concat(body.field_name === undefined ? [] : body.field_name);
  const vals = [].concat(body.field_value === undefined ? [] : body.field_value);
  const values = {};
  names.forEach((n, i) => { if (t.fields.includes(n)) values[n] = str(vals[i], 2000); });
  const missing = t.fields.filter((f) => !values[f]);
  if (missing.length) throw E.validation({ fields: `Fill in: ${missing.join(', ')}` });
  const contact = Number(body.contact_id) ? await knex('crm_contacts').where({ id: Number(body.contact_id) }).first() : null;
  const title = str(body.title, 150) || `${t.name}${contact ? ` — ${contact.organization || contact.name}` : ''}`.slice(0, 150);
  let text = t.body.replace(PH(), (m, k) => (values[k] !== undefined ? values[k] : m));
  let file = null; let filename = null;
  if (t.kind === 'docx') {
    file = docx.fill(t.file, values);
    text = docx.text(file).slice(0, 60000) || '—';
    filename = `${title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 120) || 'document'}.docx`;
  }
  const [did] = await knex('sales_documents').insert({
    file, filename, template_id: t.id, contact_id: contact ? contact.id : null, title, locale: t.locale, body: text, token: randomToken(24), created_by: ctx.userId || null,
    recipient_name: contact ? contact.name : (values.customer_name || values['اسم_العميل'] || null), recipient_email: contact ? contact.email : (values.customer_email || null), recipient_phone: contact ? contact.whatsapp || contact.phone : (values.customer_phone || null),
  });
  await audit.record(ctx, 'platform.document_created', { entityType: 'sales_document', entityId: did, newValues: { template: t.name, contact: contact ? contact.name : null } });
  if (contact) await crm().log(ctx, contact.id, 'event', `${title}`).catch(() => {});
  return did;
}

const DOC_COLS = ['id', 'template_id', 'contact_id', 'title', 'locale', 'body', 'token', 'recipient_name', 'recipient_email', 'recipient_phone', 'view_count', 'last_viewed_at', 'created_by', 'created_at', 'updated_at', 'filename'];
async function getDocument(id, { withFile = false } = {}) {
  const d = await knex('sales_documents').where({ id: Number(id) || 0 }).first(withFile ? [...DOC_COLS, 'file'] : DOC_COLS);
  if (!d) throw E.notFound('Document');
  return d;
}
const listDocuments = ({ contactId } = {}) => knex('sales_documents as d').leftJoin('crm_contacts as c', 'c.id', 'd.contact_id')
  .modify((q) => { if (contactId) q.where('d.contact_id', contactId); }).orderBy('d.id', 'desc').limit(300).select(DOC_COLS.map((c) => `d.${c}`)).select('c.name as contact_name');
/** The team edits a document before (or after) sending: the customer sees the change on the same link. */
async function updateDocument(ctx, id, body) {
  const d = await getDocument(id);
  if (d.filename) { await knex('sales_documents').where({ id: d.id }).update({ title: str(body.title, 150) || d.title, updated_at: new Date() }); return; }
  const text = String(body.body || '').replace(/\r\n/g, '\n').trim().slice(0, 60000);
  if (!text) throw E.validation({ body: 'Write the document.' });
  await knex('sales_documents').where({ id: d.id }).update({ body: text, title: str(body.title, 150) || d.title, updated_at: new Date() });
}
async function removeDocument(ctx, id) {
  const d = await getDocument(id);
  await knex('sales_documents').where({ id: d.id }).del();
  await knex('document_sends').where({ doc_type: 'document', doc_id: d.id }).del();
  await audit.record(ctx, 'platform.document_deleted', { entityType: 'sales_document', entityId: d.id, oldValues: { title: d.title } });
}
async function documentByToken(token, { count = true, withFile = false } = {}) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw E.notFound('Document');
  const d = await knex('sales_documents').where({ token }).first(withFile ? [...DOC_COLS, 'file'] : DOC_COLS);
  if (!d) throw E.notFound('Document');
  if (count) {
    await knex('sales_documents').where({ id: d.id }).update({ view_count: knex.raw('view_count + 1'), last_viewed_at: new Date() });
    if (!d.view_count && d.contact_id) await crm().log({ userId: null }, d.contact_id, 'event', `${d.title}: opened by the customer`).catch(() => {});
  }
  return d;
}

/** Plain text → safe HTML blocks: escape first, then "# " / "## " headings, "- " lists, **bold**, paragraphs. */
function render(text) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const URL = '(https?:\\/\\/[^\\s)]+|mailto:[^\\s)]+|tel:[+\\d\\s-]+|\\/(?!\\/)[^\\s)]*)'; // a site address (/app/doctors) too, never //host
  const inline = (s) => esc(s)
    .replace(/!\[([^\]]{0,120})\]\(img:([A-Za-z0-9]{8,64})\)/g, '<img class="doc-img" src="/document-image/$2" alt="$1">')
    .replace(new RegExp(`\\[icon:([a-z]+)(?:\\|([^\\]]{0,60}))?\\]\\(${URL}\\)`, 'g'), (m, name, label, href) => (ICONS[name]
      ? `<a class="doc-icon" href="${href}" target="_blank" rel="noopener" aria-label="${label || name}"><svg class="icon" aria-hidden="true"><use href="/icons.svg#i-${ICONS[name]}"></use></svg>${label ? `<span>${label}</span>` : ''}</a>` : m))
    .replace(new RegExp(`\\[([^\\]]{1,200})\\]\\(${URL}\\)`, 'g'), '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const out = []; let list = null; let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } if (list) { out.push(`<ul>${list.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`); list = null; } };
  String(text || '').split('\n').forEach((line) => {
    const l = line.trimEnd();
    if (!l.trim()) return flush();
    if (/^## /.test(l)) { flush(); return out.push(`<h3>${inline(l.slice(3))}</h3>`); }
    if (/^# /.test(l)) { flush(); return out.push(`<h2>${inline(l.slice(2))}</h2>`); }
    if (/^[-•] /.test(l)) { if (para.length) { const l2 = list; list = null; flush(); list = l2; } list = list || []; return list.push(l.slice(2)); }
    if (list) flush();
    return para.push(l);
  });
  flush();
  return out.join('\n');
}

module.exports = { DOCX_MIME, ICONS, saveDocx, saveImage, imageByToken, KNOWN, MAIN_FIELDS, fieldsOf, list, get, save, remove, suggestions, generate, getDocument, listDocuments, updateDocument, removeDocument, documentByToken, render };
