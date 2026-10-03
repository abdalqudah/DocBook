// Sending documents to patients.
//   Staff  (mounted at /app/share): GET /wa?kind=&id=[&sections=…][&lang_msg=]  → opens WhatsApp (wa.me) with a ready
//          message and the document's secure link, for the member to send from their own WhatsApp (like appointments).
//          Without a usable mobile number it shows the link and the message to copy instead.
//          POST /email {kind, id} → e-mails the patient the same link now.
//   Patient (mounted at /d): GET /d/<token> → the document itself (PDF, image, or the printable page), nothing else of
//          the record; /d/<token>/sig/<signature|stamp>.png for the marks on the printable pages. A visit link lists
//          that visit's documents, each at /d/<token>/i/<n>.
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const knex = require('../../db/knex');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const audit = require('../../core/audit');
const { translator } = require('../../core/i18n');
const { publicBase } = require('../../middleware/web');
const businesses = require('../businesses/business.service');
const svc = require('./share.service');

// ---------------------------------------------------------------- staff
const staff = express.Router();
// These GET links make a share link (and an audit row): only when clicked inside the app, never from another site.
const sameSite = (req, res, next) => (req.get('sec-fetch-site') === 'cross-site' ? res.status(403).send('Forbidden') : next());
staff.use(['/wa', '/thanks'], sameSite);
const backOf = (req) => { const r = req.get('referer') || ''; try { const u = new URL(r); return u.pathname.startsWith('/app') ? u.pathname + u.search : '/app'; } catch { return '/app'; } };

const failed = (req, res, e) => {
  if (!(e instanceof AppError) || e.status >= 500 || e.status === 404) throw e;
  const k = `share.err.${e.code}`; flash(req, 'error', req.t(k) !== k ? req.t(k) : e.message);
  return res.redirect(backOf(req));
};
/** The link and the words around it, in the message language. */
async function compose(req, src, extra = {}) {
  const kind = String(src.kind || '');
  const msgLocale = ['ar', 'en'].includes(src.lang_msg) ? src.lang_msg : req.locale;
  const made = await svc.create(req.ctx, kind, src.id, { opts: { sections: src.sections, pick: src.pick }, locale: msgLocale, base: publicBase(req), ...extra });
  const t = await require('../messaging/texts.service').translatorFor(req.ctx.businessId, msgLocale); // eslint-disable-line global-require
  const clinic = req.business;
  const clinicName = (msgLocale === 'en' && clinic.name_en) || clinic.name;
  // Dates and numbers stay whole inside Arabic text (left-to-right isolate), e.g. "حتى 2026-11-02".
  const iso = (v) => (msgLocale === 'ar' && v ? `\u2066${v}\u2069` : v);
  const label = Object.fromEntries(Object.entries(made.doc.label || {}).map(([k, v]) => [k, k === 'date' || k === 'n' ? iso(v) : v]));
  const docName = t(`share.doc.${kind}`, label);
  const vars = { name: made.doc.name || '', clinic: clinicName, doc: docName, link: made.url, date: iso(made.expires.toISOString().slice(0, 10)) };
  return { made, t, vars, msgLocale, docName, text: t('share.message', vars) };
}

// Before sending a visit's papers: the member ticks which ones go (all ticked), then WhatsApp or e-mail.
staff.get('/pick', wrap(async (req, res) => {
  const ctx = req.ctx;
  if (!svc.PERMS.visit.some((p) => ctx.permissions.has(p))) throw require('../../core/errors').E.forbidden('billing.view'); // eslint-disable-line global-require
  const doc = await svc.target(ctx, 'visit', req.query.id);
  const acc = doc.patient_id ? await require('../clinicalplus/privacy.service').access(ctx, { patientId: doc.patient_id }) : { clinical: true }; // eslint-disable-line global-require
  const items = (await svc.visitItems(ctx, doc.appointment_id, { clinical: Boolean(acc.clinical) })).map((it) => ({ ...it, name: svc.itemName(req.t, it) }));
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  const email = await svc.emailOf(ctx, doc);
  return res.page('pages/share/pick', { title: req.t('share.pick_title'), apptId: doc.appointment_id, patient: doc.name, items, phone: doc.phone, email, mailOn: await mailer.configuredFor(ctx.businessId) });
}));

// End of the visit: "thank you for visiting <clinic> — please rate your visit: <link>" on WhatsApp. The link is the
// clinic's Google review link (Website → Connections) when it set one, else its own review page for this visit.
staff.get('/thanks', wrap(async (req, res) => {
  const ctx = req.ctx;
  if (!['appointments.manage', 'billing.view', 'clinical.view'].some((p) => ctx.permissions.has(p))) throw require('../../core/errors').E.forbidden('appointments.manage'); // eslint-disable-line global-require
  const doc = await svc.target(ctx, 'visit', req.query.id);
  const a = await knex('appointments').where({ id: doc.appointment_id, business_id: ctx.businessId }).first('id', 'business_id', 'status', 'payment_status');
  if (!(a.status === 'completed' || a.payment_status === 'paid')) return failed(req, res, new AppError('THANKS_NOT_DONE', 'The visit is not finished yet.', 409));
  const msgLocale = ['ar', 'en'].includes(req.query.lang_msg) ? req.query.lang_msg : req.locale;
  const texts = require('../messaging/texts.service'); // eslint-disable-line global-require
  const t = await texts.translatorFor(ctx.businessId, msgLocale);
  const clinic = req.business;
  // Where the rating goes: the clinic's choice (Settings → Message texts) — Google, its own page, or Google when set.
  let link = await texts.googleReviewLink(ctx.businessId, { manual: true });
  let via = 'google';
  if (!link) {
    const messaging = require('../messaging/messaging.service'); // eslint-disable-line global-require
    const { token } = await messaging.linkFor(a, 'review');
    link = messaging.reviewUrl(publicBase(req), token);
    via = 'site';
  }
  const text = t('share.thanks_message', { name: doc.name || '', clinic: (msgLocale === 'en' && clinic.name_en) || clinic.name, link });
  await audit.record(ctx, 'share.thanks_sent', { entityType: 'appointment', entityId: a.id, newValues: { via } });
  const to = doc.phone ? await require('../messaging/messaging.service').waNumberFor(ctx.businessId, doc.phone) : null; // eslint-disable-line global-require
  if (!to) return res.page('pages/share/link', { title: req.t('share.thanks_title'), url: link, text, docName: req.t('share.thanks_link'), noPhone: true });
  return res.redirect(`https://wa.me/${to}?text=${encodeURIComponent(text)}`);
}));

const sendWa = wrap(async (req, res) => {
  let c;
  try { c = await compose(req, { ...req.query, ...(req.method === 'POST' ? req.body : {}) }); } catch (e) { return failed(req, res, e); }
  const to = c.made.doc.phone ? await require('../messaging/messaging.service').waNumberFor(req.ctx.businessId, c.made.doc.phone) : null; // eslint-disable-line global-require
  if (!to) return res.page('pages/share/link', { title: req.t('share.title'), url: c.made.url, text: c.text, docName: c.docName, noPhone: true });
  const wa = `https://wa.me/${to}?text=${encodeURIComponent(c.text)}`;
  // After a form post the browser may not follow a redirect to another site (CSP form-action 'self'):
  // a page that moves on to WhatsApp by itself, with the link to tap if it does not.
  if (req.method === 'POST') return res.page('pages/share/go', { layout: 'auth', title: req.t('share.title'), wa, noindex: true });
  return res.redirect(wa);
});
staff.get('/wa', sendWa);
staff.post('/wa', sendWa); // from the "choose the papers" form

// E-mails the patient the same secure link straight away (from the clinic's own address when it connected one).
staff.post('/email', wrap(async (req, res) => {
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  if (!(await mailer.configuredFor(req.ctx.businessId))) return failed(req, res, new AppError('SHARE_NO_MAIL', 'E-mail is not set up.', 409));
  let c;
  try { c = await compose(req, { ...req.query, ...req.body }, { needEmail: true }); } catch (e) { return failed(req, res, e); }
  const clinic = req.business;
  const subject = c.t('share.mail_subject', c.vars);
  const html = mailer.layout({ locale: c.msgLocale, title: subject, body: c.t('share.mail_body', c.vars), cta: c.t('share.mail_cta'), href: c.made.url, clinic, base: publicBase(req) });
  let ok = false;
  try { ok = await mailer.send({ to: c.made.doc.email, subject, html, replyTo: clinic.email || undefined, businessId: clinic.id, kind: 'patient_letters', fromName: (c.msgLocale === 'en' && clinic.name_en) || clinic.name }); } catch { ok = false; }
  await audit.record(req.ctx, ok ? 'share.emailed' : 'share.email_failed', { entityType: String(req.body.kind || req.query.kind), entityId: Number(req.body.id || req.query.id) || null, newValues: { link_id: c.made.id } });
  if (!ok) { await knex('share_links').where({ id: c.made.id }).update({ revoked_at: new Date() }); return failed(req, res, new AppError('SHARE_MAIL_FAILED', 'Sending failed.', 409)); }
  flash(req, 'success', req.t('share.emailed', { email: c.made.doc.email }));
  return res.redirect(backOf(req));
}));

// ---------------------------------------------------------------- patient
const pub = express.Router();
pub.use(rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 120, standardHeaders: true, legacyHeaders: false }));
const ctxFor = (link, clinic) => ({ businessId: link.business_id, userId: null, ownDoctorId: null, permissions: new Set(), currency: clinic.currency, timezone: clinic.timezone, today: null });
const gone = (req, res) => res.status(404).page('pages/share/gone', { layout: 'public', title: req.t('share.gone_title'), noindex: true });

async function load(req) {
  const link = await svc.resolve(req.params.token);
  if (!link) return null;
  const clinic = await businesses.get(link.business_id);
  if (!clinic || clinic.status === 'suspended') return null;
  return { link, clinic, ctx: { ...ctxFor(link, clinic), baseUrl: publicBase(req) } };
}

/** The visit link's n-th document, as a link of its own (null when out of range). */
const itemOf = (link, n) => {
  const it = link.kind === 'visit' && (link.options.items || [])[Number(n)];
  return it ? { ...link, kind: it.kind, ref_id: it.id, options: it.options || {} } : null;
};

/** Sends one shared document: PDF, the stored file, or the printable page on the clinic's letterhead. */
async function serveDoc(req, res, got, doc, sigBase) {
  const { clinic, ctx } = got;
  res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  if (['prescription', 'report', 'certificate'].includes(doc.kind)) {
    if (!doc.appointment_id) return gone(req, res);
    if (doc.kind === 'certificate' && !(await knex('certificates').where({ id: doc.ref_id, business_id: doc.business_id }).whereNull('revoked_at').first('id'))) return gone(req, res);
    const docs = require('../patientdocs/docs.service'); // eslint-disable-line global-require
    const { filename, pdf } = await docs.render(ctx, doc.appointment_id, { kind: doc.kind, ref_id: doc.kind === 'report' ? doc.appointment_id : doc.ref_id, options: doc.options }, doc.locale);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'X-Content-Type-Options': 'nosniff' });
    return res.end(pdf);
  }
  if (doc.kind === 'file') {
    const f = await knex('patient_files').where({ id: doc.ref_id, business_id: doc.business_id }).first();
    if (!f) return gone(req, res);
    res.set({
      'Content-Type': f.mime, 'Content-Length': String(f.data.length), 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': `inline; filename="file-${f.id}.${f.name.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    });
    return res.end(f.data);
  }
  // Printable pages on the clinic's letterhead (invoice, order, referral), in the link's language.
  req.query.print = '1';
  localise(req, res, doc.locale, clinic);
  res.locals.sigSrc = (what) => `${sigBase}/sig/${what}.png`;
  res.locals.shareBase = sigBase; // the page's "save as PDF" and "share" buttons use `${shareBase}/pdf`
  if (doc.kind === 'invoice') {
    const invoiceDoc = require('../clinic/invoice-doc'); // eslint-disable-line global-require
    res.locals.invoiceTpl = await require('../platformops/ops.service').invoiceTemplate(clinic.id); // eslint-disable-line global-require
    const paper = invoiceDoc.paperOf({}, res.locals.invoiceTpl);
    const d = await invoiceDoc.load(ctx, doc.ref_id, { paper });
    const number = `${(res.locals.invoiceTpl && res.locals.invoiceTpl.prefix) || ''}${d.inv.invoice_number}`;
    return res.page('pages/clinic/billing/show', { title: number, doc: d, inv: d.inv, patient: d.patient, issued: d.issued, paper, number, printable: true, pageStyles: ['/css/invoice.css'] });
  }
  const orders = require('../orders/orders.service'); // eslint-disable-line global-require
  const lib = require('../clinic/records.lib'); // eslint-disable-line global-require
  const d = doc.kind === 'order' ? await orders.getOrder(ctx, doc.ref_id) : await orders.getReferral(ctx, doc.ref_id);
  return res.page(`pages/orders/${doc.kind}`, { title: clinic.name, doc: d, age: lib.ageOf(d.date_of_birth, new Date().toISOString().slice(0, 10)), printable: true, pageStyles: ['/css/appointments.css'] });
}

function localise(req, res, locale, clinic) {
  req.locale = locale;
  res.locals.locale = locale; res.locals.dir = locale === 'ar' ? 'rtl' : 'ltr'; res.locals.t = translator(locale);
  res.locals.business = clinic; res.locals.currency = clinic.currency; res.locals.currentUser = null;
  res.locals.logoSrc = clinic.logo_mime ? `/${clinic.slug}/logo?v=${clinic.logo_version || 0}` : null;
  res.locals.can = () => false; res.locals.canAny = () => false;
  res.locals.publicShare = true;
}

pub.get('/:token', wrap(async (req, res) => {
  const got = await load(req);
  if (!got) return gone(req, res);
  await svc.opened(got.link);
  if (got.link.kind !== 'visit') return serveDoc(req, res, got, got.link, `/d/${req.params.token}`);
  // A visit: the list of its documents, each opening on its own.
  res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  localise(req, res, got.link.locale, got.clinic);
  const t = res.locals.t;
  const items = (got.link.options.items || []).map((it, i) => ({ ...it, href: `/d/${req.params.token}/i/${i}`, name: svc.itemName(t, it) }));
  // A greeting by the time the page is opened (the clinic's clock), with the patient's name.
  const appt = got.link.appointment_id ? await knex('appointments as a').leftJoin('patients as p', 'p.id', 'a.patient_id').where({ 'a.id': got.link.appointment_id, 'a.business_id': got.link.business_id }).first('a.patient_name', 'p.full_name') : null;
  const name = appt ? String(appt.full_name || appt.patient_name || '').trim() : '';
  const { minutes } = require('../clinic/scheduling').clinicNow(got.clinic.timezone || 'UTC'); // eslint-disable-line global-require
  const greeting = t(minutes >= 4 * 60 && minutes < 12 * 60 ? 'share.greet_morning' : 'share.greet_evening', { name }).replace(/[،,]\s*$/, '');
  return res.page('pages/share/visit', { layout: 'public', title: t('share.visit_title'), noindex: true, greeting, clinic: { ...got.clinic, displayName: (got.link.locale === 'en' && got.clinic.name_en) || got.clinic.name }, items, expires: new Date(got.link.expires_at).toISOString().slice(0, 10) });
}));

pub.get('/:token/i/:n(\\d+)', wrap(async (req, res) => {
  const got = await load(req);
  const doc = got && itemOf(got.link, req.params.n);
  if (!doc) return gone(req, res);
  return serveDoc(req, res, got, doc, `/d/${req.params.token}/i/${req.params.n}`);
}));

/** The document as PDF bytes: the visit papers through patientdocs, the invoice / order / referral built here. */
async function pdfOf(got, doc) {
  const { clinic, ctx } = got;
  const docsSvc = require('../patientdocs/docs.service'); // eslint-disable-line global-require
  const documents = require('../patientdocs/documents'); // eslint-disable-line global-require
  if (['prescription', 'report', 'certificate'].includes(doc.kind)) {
    if (doc.kind === 'certificate' && !(await knex('certificates').where({ id: doc.ref_id, business_id: doc.business_id }).whereNull('revoked_at').first('id'))) return null;
    return docsSvc.render(ctx, doc.appointment_id, { kind: doc.kind, ref_id: doc.kind === 'report' ? doc.appointment_id : doc.ref_id, options: doc.options }, doc.locale);
  }
  const info = await docsSvc.clinicInfo(clinic.id);
  const sig = require('../signatures/signatures.service'); // eslint-disable-line global-require
  if (doc.kind === 'invoice') {
    const invoiceDoc = require('../clinic/invoice-doc'); // eslint-disable-line global-require
    const tpl = await require('../platformops/ops.service').invoiceTemplate(clinic.id) || {}; // eslint-disable-line global-require
    const d = await invoiceDoc.load(ctx, doc.ref_id, { paper: 'a4' });
    const marks = d.stampOn === false ? {} : await sig.forDocument(clinic.id, 'invoices', null).catch(() => ({}));
    const number = `${tpl.prefix || ''}${d.inv.invoice_number}`;
    return { filename: `invoice-${String(number).replace(/[^A-Za-z0-9-]/g, '')}.pdf`, pdf: await documents.invoice({ ...d, clinic: info, number, tpl, marks }, doc.locale) };
  }
  if (doc.kind === 'order' || doc.kind === 'referral') return docsSvc.orderPdf(ctx, doc.kind, doc.ref_id, doc.locale);
  return null;
}

async function sendPdf(req, res, got, doc) {
  if (!got || !doc) return gone(req, res);
  const out = await pdfOf(got, doc);
  if (!out) return gone(req, res);
  res.set({
    'Content-Type': 'application/pdf', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer',
    'Content-Disposition': `${req.query.dl === '1' ? 'attachment' : 'inline'}; filename="${out.filename}"`,
  });
  return res.end(out.pdf);
}
pub.get('/:token/pdf', wrap(async (req, res) => { const got = await load(req); return sendPdf(req, res, got, got && got.link.kind !== 'visit' && got.link.kind !== 'file' ? got.link : null); }));
pub.get('/:token/i/:n(\\d+)/pdf', wrap(async (req, res) => { const got = await load(req); const doc = got && itemOf(got.link, req.params.n); return sendPdf(req, res, got, doc && doc.kind !== 'file' ? doc : null); }));

async function sendSig(req, res, got, doc) {
  const { sendImage } = require('../signatures/web'); // eslint-disable-line global-require
  if (!doc || !['invoice', 'order', 'referral'].includes(doc.kind)) return sendImage(res, null);
  const sig = require('../signatures/signatures.service'); // eslint-disable-line global-require
  let doctorId = null;
  if (doc.kind !== 'invoice') {
    const row = await knex(doc.kind === 'order' ? 'medical_orders' : 'referrals').where({ id: doc.ref_id, business_id: doc.business_id }).first('doctor_id');
    doctorId = row && row.doctor_id;
  }
  const m = await sig.forDocument(doc.business_id, doc.kind === 'invoice' ? 'invoices' : 'reports', doctorId);
  return sendImage(res, { image: m[req.params.what] });
}
pub.get('/:token/sig/:what(signature|stamp).png', wrap(async (req, res) => { const got = await load(req); return sendSig(req, res, got, got && got.link); }));
pub.get('/:token/i/:n(\\d+)/sig/:what(signature|stamp).png', wrap(async (req, res) => { const got = await load(req); return sendSig(req, res, got, got && itemOf(got.link, req.params.n)); }));

module.exports = { staff, pub };
