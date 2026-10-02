// Sending documents to patients.
//   Staff  (mounted at /app/share): GET /wa?kind=&id=[&sections=…][&lang_msg=]  → opens WhatsApp (wa.me) with a ready
//          message and the document's secure link, for the member to send from their own WhatsApp (like appointments).
//          Without a usable mobile number it shows the link and the message to copy instead.
//   Patient (mounted at /d): GET /d/<token> → the document itself (PDF, image, or the printable page), nothing else of
//          the record; /d/<token>/sig/<signature|stamp>.png for the marks on the printable pages.
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const knex = require('../../db/knex');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const { publicBase } = require('../../middleware/web');
const businesses = require('../businesses/business.service');
const svc = require('./share.service');

// ---------------------------------------------------------------- staff
const staff = express.Router();
const backOf = (req) => { const r = req.get('referer') || ''; try { const u = new URL(r); return u.pathname.startsWith('/app') ? u.pathname + u.search : '/app'; } catch { return '/app'; } };

staff.get('/wa', wrap(async (req, res) => {
  const kind = String(req.query.kind || '');
  const msgLocale = ['ar', 'en'].includes(req.query.lang_msg) ? req.query.lang_msg : req.locale;
  let made;
  try {
    made = await svc.create(req.ctx, kind, req.query.id, { opts: { sections: req.query.sections }, locale: msgLocale, base: publicBase(req) });
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 404) throw e;
    const k = `share.err.${e.code}`; flash(req, 'error', req.t(k) !== k ? req.t(k) : e.message);
    return res.redirect(backOf(req));
  }
  const t = translator(msgLocale);
  const clinic = req.business;
  const clinicName = (msgLocale === 'en' && clinic.name_en) || clinic.name;
  const docName = t(`share.doc.${kind}`, made.doc.label || {});
  const text = t('share.message', { name: made.doc.name || '', clinic: clinicName, doc: docName, link: made.url, date: made.expires.toISOString().slice(0, 10) });
  const to = made.doc.phone ? await require('../messaging/messaging.service').waNumberFor(req.ctx.businessId, made.doc.phone) : null; // eslint-disable-line global-require
  if (!to) return res.page('pages/share/link', { title: req.t('share.title'), url: made.url, text, docName, noPhone: true });
  return res.redirect(`https://wa.me/${to}?text=${encodeURIComponent(text)}`);
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

pub.get('/:token', wrap(async (req, res) => {
  const got = await load(req);
  if (!got) return gone(req, res);
  const { link, clinic, ctx } = got;
  res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  await svc.opened(link);
  if (['prescription', 'report', 'certificate'].includes(link.kind)) {
    if (!link.appointment_id) return gone(req, res);
    const docs = require('../patientdocs/docs.service'); // eslint-disable-line global-require
    const { filename, pdf } = await docs.render(ctx, link.appointment_id, { kind: link.kind, ref_id: link.kind === 'report' ? link.appointment_id : link.ref_id, options: link.options }, link.locale);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'X-Content-Type-Options': 'nosniff' });
    return res.end(pdf);
  }
  if (link.kind === 'file') {
    const f = await knex('patient_files').where({ id: link.ref_id, business_id: link.business_id }).first();
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
  req.locale = link.locale;
  res.locals.locale = link.locale; res.locals.dir = link.locale === 'ar' ? 'rtl' : 'ltr'; res.locals.t = translator(link.locale);
  res.locals.business = clinic; res.locals.currency = clinic.currency; res.locals.currentUser = null;
  res.locals.logoSrc = clinic.logo_mime ? `/${clinic.slug}/logo?v=${clinic.logo_version || 0}` : null;
  res.locals.sigSrc = (what) => `/d/${req.params.token}/sig/${what}.png`;
  res.locals.can = () => false; res.locals.canAny = () => false;
  res.locals.publicShare = true;
  if (link.kind === 'invoice') {
    const invoiceDoc = require('../clinic/invoice-doc'); // eslint-disable-line global-require
    res.locals.invoiceTpl = await require('../platformops/ops.service').invoiceTemplate(clinic.id); // eslint-disable-line global-require
    const paper = invoiceDoc.paperOf({}, res.locals.invoiceTpl);
    const doc = await invoiceDoc.load(ctx, link.ref_id, { paper });
    const number = `${(res.locals.invoiceTpl && res.locals.invoiceTpl.prefix) || ''}${doc.inv.invoice_number}`;
    return res.page('pages/clinic/billing/show', { title: number, doc, inv: doc.inv, patient: doc.patient, issued: doc.issued, paper, number, printable: true, pageStyles: ['/css/invoice.css'] });
  }
  const orders = require('../orders/orders.service'); // eslint-disable-line global-require
  const lib = require('../clinic/records.lib'); // eslint-disable-line global-require
  const d = link.kind === 'order' ? await orders.getOrder(ctx, link.ref_id) : await orders.getReferral(ctx, link.ref_id);
  return res.page(`pages/orders/${link.kind}`, { title: clinic.name, doc: d, age: lib.ageOf(d.date_of_birth, new Date().toISOString().slice(0, 10)), printable: true, pageStyles: ['/css/appointments.css'] });
}));

pub.get('/:token/sig/:what(signature|stamp).png', wrap(async (req, res) => {
  const { sendImage } = require('../signatures/web'); // eslint-disable-line global-require
  const got = await load(req);
  if (!got || !['invoice', 'order', 'referral'].includes(got.link.kind)) return sendImage(res, null);
  const sig = require('../signatures/signatures.service'); // eslint-disable-line global-require
  let doctorId = null;
  if (got.link.kind !== 'invoice') {
    const row = await knex(got.link.kind === 'order' ? 'medical_orders' : 'referrals').where({ id: got.link.ref_id, business_id: got.link.business_id }).first('doctor_id');
    doctorId = row && row.doctor_id;
  }
  const m = await sig.forDocument(got.link.business_id, got.link.kind === 'invoice' ? 'invoices' : 'reports', doctorId);
  return sendImage(res, { image: m[req.params.what] });
}));

module.exports = { staff, pub };
