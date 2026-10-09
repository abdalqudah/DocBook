// Pharmacies, imaging centres and laboratories (Settings → Pharmacies & centres) and sending papers to them.
//   /app/settings/partners            list, add, edit, delete (settings.manage)
//   POST /app/centres/send            a prescription or a lab / imaging request to a partner: WhatsApp or e-mail with a
//                                     secure link to that paper only, or — a centre inside the clinic — onto its list
//   GET  /app/centres/:id             a centre inside the clinic: what was sent to it, open requests first
//   POST /app/centres/sends/:id/done a prescription handed over at the pharmacy inside the clinic
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { publicBase } = require('../../middleware/web');
const { render } = require('../settings/common');
const audit = require('../../core/audit');
const svc = require('./partners.service');

const router = express.Router();

// ---------------------------------------------------------------- settings
async function settingsPage(req, res, extra = {}) {
  const all = await svc.list(req.ctx.businessId);
  const edit = req.query.edit ? all.find((p) => p.id === Number(req.query.edit)) || null : null;
  // ?kind=pharmacy|lab|imaging: one kind only (the cards of Clinic → Medical setup)
  const only = svc.KINDS.includes(req.query.kind) ? req.query.kind : (edit && req.query.kind ? edit.kind : null);
  render(req, res, 'partners', 'partners', { title: only ? req.t(`centres.kinds.${only}`) : req.t('settings.nav_partners'), all, edit, only, KINDS: only ? [only] : svc.KINDS, ...(only ? { workspace: 'clinic' } : {}), ...extra });
}
const back = (req) => (req.query.kind && svc.KINDS.includes(req.query.kind) ? `/app/settings/partners?kind=${req.query.kind}` : (req.body && req.body.kind ? `/app/settings/partners#k-${req.body.kind}` : '/app/settings/partners'));
router.get('/settings/partners', can('settings.manage'), wrap((req, res) => settingsPage(req, res)));
router.post('/settings/partners', can('settings.manage'), form(async (req, res) => {
  await svc.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('centres.saved'));
  res.redirect(back(req));
}, settingsPage));
router.post('/settings/partners/:id(\\d+)', can('settings.manage'), form(async (req, res) => {
  await svc.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('centres.saved'));
  res.redirect(back(req));
}, (req, res, extra) => settingsPage(Object.assign(req, { query: { ...req.query, edit: req.params.id } }), res, extra)));
router.post('/settings/partners/:id(\\d+)/delete', can('settings.manage'), wrap(async (req, res) => {
  await svc.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('centres.deleted'));
  res.redirect(back(req));
}));

// ---------------------------------------------------------------- sending a paper
const DOC_PERMS = ['clinical.view', 'prescriptions.create', 'clinical.edit'];
const safeBack = (v) => (typeof v === 'string' && /^\/app\/[\w\-/?=&.%#]*$/.test(v) && !v.startsWith('//') ? v : '/app');

router.post('/centres/send', canAny(...DOC_PERMS), wrap(async (req, res) => {
  const { ctx } = req;
  const backTo = safeBack(req.body.return_to);
  const fail = (code) => { flash(req, 'error', req.t(`centres.err.${code}`)); return res.redirect(backTo); };
  const docKind = req.body.doc_kind === 'order' ? 'order' : 'prescription';
  const doc = await svc.docOf(ctx, docKind, req.body.doc_id);
  const partner = await svc.get(ctx, req.body.partner_id);
  if (!partner.is_active || partner.kind !== doc.partnerKind) return fail('WRONG_PARTNER');
  const privacy = require('../clinicalplus/privacy.service'); // eslint-disable-line global-require
  const appt = doc.appointment_id ? await require('../../db/knex')('appointments').where({ business_id: ctx.businessId, id: doc.appointment_id }).first('patient_id') : null; // eslint-disable-line global-require
  if (appt && appt.patient_id && !(await privacy.access(ctx, { patientId: appt.patient_id })).clinical) throw new AppError('RECORD_RESTRICTED', 'Restricted.', 403);

  // A centre inside the clinic: the paper goes onto its list in DocBook (no message, nothing leaves the clinic).
  if (partner.in_house) {
    await svc.record(ctx, partner, doc, docKind, 'in_house');
    flash(req, 'success', req.t('centres.sent_in_house', { name: partner.name }));
    return res.redirect(backTo);
  }
  const channel = req.body.channel === 'email' ? 'email' : 'whatsapp';
  const locale = ['ar', 'en'].includes(req.body.lang_msg) ? req.body.lang_msg : req.locale;
  const share = require('../share/share.service'); // eslint-disable-line global-require
  const texts = require('../messaging/texts.service'); // eslint-disable-line global-require
  const made = await share.create(ctx, docKind, doc.id, { locale, base: publicBase(req) });
  const t = await texts.translatorFor(ctx.businessId, locale);
  const clinic = req.business;
  const iso = (v) => (locale === 'ar' && v ? `⁦${v}⁩` : v);
  const docName = t(`share.doc.${docKind}`, Object.fromEntries(Object.entries(made.doc.label || {}).map(([k, v]) => [k, k === 'n' || k === 'date' ? iso(v) : v])));
  const vars = { partner: partner.name, clinic: (locale === 'en' && clinic.name_en) || clinic.name, doc: docName, name: made.doc.name || doc.patient_name || '', link: made.url, date: iso(made.expires.toISOString().slice(0, 10)) };
  const knex = require('../../db/knex'); // eslint-disable-line global-require
  const withdraw = () => knex('share_links').where({ id: made.id }).update({ revoked_at: new Date() });

  if (channel === 'email') {
    const mailer = require('../../core/mailer'); // eslint-disable-line global-require
    if (!partner.email) { await withdraw(); return fail('NO_EMAIL'); }
    if (!(await mailer.configuredFor(ctx.businessId))) { await withdraw(); return fail('NO_MAIL'); }
    const subject = t('share.partner_mail_subject', vars);
    const html = mailer.layout({ locale, title: subject, body: t('share.partner_mail_body', vars), cta: t('share.mail_cta'), href: made.url, clinic, base: publicBase(req) });
    let ok = false;
    try { ok = await mailer.send({ to: partner.email, subject, html, replyTo: clinic.email || undefined, businessId: clinic.id, kind: 'patient_letters', fromName: vars.clinic }); } catch { ok = false; }
    if (!ok) { await withdraw(); return fail('MAIL_FAILED'); }
    await svc.record(ctx, partner, doc, docKind, 'email', made.id);
    flash(req, 'success', req.t('centres.emailed', { name: partner.name }));
    return res.redirect(backTo);
  }
  const to = partner.phone ? await require('../messaging/messaging.service').waNumberFor(ctx.businessId, partner.phone) : null; // eslint-disable-line global-require
  if (!to) { await withdraw(); return fail('NO_PHONE'); }
  await svc.record(ctx, partner, doc, docKind, 'whatsapp', made.id);
  const wa = `https://wa.me/${to}?text=${encodeURIComponent(t('share.partner_message', vars))}`;
  // A form post may not redirect to another site (CSP form-action 'self'): a page that moves on to WhatsApp itself.
  return res.page('pages/share/go', { layout: 'auth', title: req.t('share.title'), wa, noindex: true });
}));

// ---------------------------------------------------------------- a centre inside the clinic
router.get('/centres/:id(\\d+)', canAny(...DOC_PERMS, 'patients.edit'), wrap(async (req, res) => {
  const q = await svc.queue(req.ctx, Number(req.params.id));
  if (!q.partner.in_house) return res.redirect('/app/settings/partners');
  res.page('pages/partners/queue', { title: q.partner.name, ...q });
}));
router.post('/centres/sends/:id(\\d+)/done', canAny(...DOC_PERMS, 'patients.edit'), wrap(async (req, res) => {
  const s = await svc.markDone(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('centres.marked_done'));
  res.redirect(`/app/centres/${s.partner_id}`);
}));

/** For every app page: the clinic's active partners (the "send to pharmacy / centre" menus). */
router.locals = wrap(async (req, res, next) => {
  if (req.method === 'GET' && req.ctx && req.ctx.businessId) {
    res.locals.clinicPartners = await svc.list(req.ctx.businessId, { activeOnly: true });
    res.locals.currentPath = req.originalUrl; // where the "send to" menu comes back to
  }
  next();
});

module.exports = router;
