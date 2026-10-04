// Documents a doctor sends to the patient after a visit (prescription, consultation report, medical certificate):
// what was shared (patient_documents), the data each PDF needs, generating the PDF on demand, and the e-mail.
// The PDF is always built from the clinical record as it is now, so the patient never gets an outdated copy;
// a shared document can be withdrawn ("revoked") and then disappears from the patient's page.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const brand = require('../../config/brand');
const { translator } = require('../../core/i18n');
const { E } = require('../../core/errors');
const appts = require('../clinic/appointments.service');
const clinical = require('../clinic/clinical.service');
const icd = require('../clinicalplus/icd.service'); // ICD-10 codes of the visit
const documents = require('./documents');
const { isPdfImage } = require('./pdf');

const KINDS = ['prescription', 'report', 'certificate'];
const SECTIONS = documents.REPORT_SECTIONS;

/** The certificates module (another team's) — used only when it is installed. */
function certificatesService() {
  try { return require('../certificates/certificates.service'); } catch { return null; } // eslint-disable-line global-require
}

function ageOn(dob, onDate) {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(String(dob))) return null;
  const [y, m, d] = String(dob).split('-').map(Number);
  const [ty, tm, td] = String(onDate || require('../clinic/scheduling').clinicNow('Asia/Amman').date).split('-').map(Number); // eslint-disable-line global-require
  let age = ty - y;
  if (tm < m || (tm === m && td < d)) age -= 1;
  return age >= 0 ? age : null;
}

async function clinicInfo(businessId) {
  const c = await require('../../core/imageopt').pdfLogo(await knex('businesses').where({ id: businessId }).first('id', 'name', 'name_en', 'address', 'city', 'phone', 'email', 'logo', 'logo_mime', 'timezone', 'currency', 'color', 'tax_number')); // eslint-disable-line global-require
  if (!c) throw E.notFound('Clinic');
  // The same letterhead settings as every other paper (Settings → Invoice template).
  const tpl = await require('../platformops/ops.service').invoiceTemplate(businessId).catch(() => ({})); // eslint-disable-line global-require
  const on = (f) => !tpl || tpl[f] !== false;
  const lh = { logo: on('show_logo'), name: on('show_name'), contact: on('show_contact'), size: ['s', 'm', 'l', 'xl'].includes(tpl && tpl.logo_size) ? tpl.logo_size : 'm' };
  return { ...c, logo: lh.logo && isPdfImage(c.logo) ? c.logo : null, accent: await accentOf(c), lh };
}

/** The clinic's own colour for its papers: its website's main colour when the site is live, else the clinic colour. */
async function accentOf(c) {
  const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  try {
    const st = await require('../website/site.service').publicState(c.id); // eslint-disable-line global-require
    const p = st && st.status === 'live' && st.doc && st.doc.brand && st.doc.brand.primary;
    if (p && HEX.test(p)) return p;
  } catch { /* the clinic colour below */ }
  return c.color && HEX.test(c.color) ? c.color : null;
}

/** A test request or referral letter as PDF (signed by its doctor, on the clinic's letterhead): { filename, pdf }. */
async function orderPdf(ctx, kind, id, locale = 'ar') {
  const orders = require('../orders/orders.service'); // eslint-disable-line global-require
  const lib = require('../clinic/records.lib'); // eslint-disable-line global-require
  const sig = require('../signatures/signatures.service'); // eslint-disable-line global-require
  const o = kind === 'order' ? await orders.getOrder(ctx, id) : await orders.getReferral(ctx, id);
  const [clinic, marks] = await Promise.all([clinicInfo(ctx.businessId), sig.forDocument(ctx.businessId, 'reports', o.doctor_id).catch(() => ({}))]);
  const pdf = await documents.orderSheet({ clinic, doc: o, kind, age: lib.ageOf(o.date_of_birth, require('../clinic/scheduling').clinicNow(clinic.timezone || 'Asia/Amman').date), marks }, locale);
  return { filename: `${kind}-${o.id}.pdf`, pdf, doc: o };
}

/** Everything about the visit the documents print (patient, doctor, whether it was online). */
async function visitInfo(ctx, apptId) {
  const a = await appts.get(ctx, apptId); // clinic + a doctor's own schedule
  if (a.appointment_type === 'blocked') throw E.notFound('Appointment');
  const [patient, doctor] = await Promise.all([
    a.patient_id ? knex('patients').where({ id: a.patient_id, business_id: ctx.businessId }).first('date_of_birth', 'gender') : null,
    a.doctor_id ? knex('doctors').where({ id: a.doctor_id, business_id: ctx.businessId }).first('full_name', 'full_name_en', 'specialization', 'specialization_en', 'license_number') : null,
  ]);
  return {
    a, patient_name: a.patient_name, age: patient ? ageOn(patient.date_of_birth, a.appointment_date) : null, gender: patient ? patient.gender : null,
    visit_date: a.appointment_date, online: a.appointment_type === 'online', appointment_id: a.id,
    doctor_name: doctor ? doctor.full_name : null, doctor_name_en: doctor ? doctor.full_name_en : null,
    specialization: doctor ? doctor.specialization : null, specialization_en: doctor ? doctor.specialization_en : null, license_number: doctor ? doctor.license_number : null,
  };
}

/** The choices on the visit page: prescriptions, report sections that have content, issued certificates. */
async function choices(ctx, apptId) {
  const [rxs, consult] = await Promise.all([clinical.prescriptionsFor(ctx, apptId), clinical.consultation(ctx, apptId)]);
  const c = consult || {};
  const sections = SECTIONS.filter((s) => (s === 'vitals' ? Object.keys(c.vital_signs || {}).length > 0 : Boolean(c[s])));
  const certs = certificatesService() && ctx.permissions && (ctx.permissions.has('certificates.view') || ctx.permissions.has('certificates.issue'))
    ? await certificatesService().forVisit(ctx, apptId).catch(() => [])
    : [];
  return { rxs, sections, certs: certs.filter((x) => !x.revoked_at) };
}

const sharedList = (businessId, apptId) => knex('patient_documents').where({ business_id: businessId, appointment_id: apptId }).whereNull('revoked_at').orderBy('id');

/** Builds the PDF of one document. `doc` = { kind, ref_id, options } (a patient_documents row or an ad-hoc request). */
async function render(ctx, apptId, doc, locale = 'ar') {
  const v = await visitInfo(ctx, apptId);
  const clinic = await clinicInfo(ctx.businessId);
  if (doc.kind === 'prescription') {
    const rx = await clinical.prescription(ctx, Number(doc.ref_id));
    if (rx.appointment_id !== v.a.id) throw E.notFound('Prescription');
    const codes = await icd.diagnosesFor(ctx.businessId, v.a.id);
    return { filename: `prescription-${rx.id}.pdf`, pdf: await documents.prescription({ ...v, clinic, rx, codes }, locale) };
  }
  if (doc.kind === 'report') {
    const consult = await clinical.consultation(ctx, v.a.id);
    const opts = typeof doc.options === 'string' ? JSON.parse(doc.options || '{}') : (doc.options || {});
    const sections = (opts.sections || []).filter((s) => SECTIONS.includes(s));
    const codes = await icd.diagnosesFor(ctx.businessId, v.a.id);
    return { filename: `consultation-report-${v.a.id}.pdf`, pdf: await documents.report({ ...v, clinic, consult, sections, codes }, locale) };
  }
  if (doc.kind === 'certificate') {
    const svc = certificatesService();
    if (!svc) throw E.notFound('Document');
    const cert = await svc.get({ ...ctx, ownDoctorId: ctx.ownDoctorId || null }, Number(doc.ref_id));
    if (cert.appointment_id !== v.a.id) throw E.notFound('Document');
    const base = ctx.baseUrl || require('../../config').appUrl; // eslint-disable-line global-require
    return { filename: `${String(cert.serial || 'certificate').replace(/[^A-Za-z0-9-]/g, '')}.pdf`, pdf: await documents.certificate({ clinic, cert, verifyUrl: svc.verifyUrl(base, cert.verify_code) }, locale) };
  }
  throw E.notFound('Document');
}

/**
 * "Send to patient": records the chosen documents as shared and e-mails them (PDF attachments) when e-mail is set
 * up and the patient has an address. input: { rx: [ids], report: '1', sections: [...], cert: [ids], locale }
 * @returns { shared: n, emailed: boolean }
 */
async function share(ctx, apptId, input) {
  const v = await visitInfo(ctx, apptId);
  const ch = await choices(ctx, v.a.id);
  const arr = (x) => (Array.isArray(x) ? x : x === undefined || x === null || x === '' ? [] : [x]);
  const locale = input.locale === 'en' ? 'en' : 'ar';
  const picks = [];
  arr(input.rx).map(Number).filter((id) => ch.rxs.some((r) => r.id === id)).forEach((id) => picks.push({ kind: 'prescription', ref_id: id, options: null }));
  const sections = arr(input.sections).filter((s) => SECTIONS.includes(s));
  if (input.report === '1' && sections.length) picks.push({ kind: 'report', ref_id: null, options: JSON.stringify({ sections }) });
  arr(input.cert).map(Number).filter((id) => ch.certs.some((c) => c.id === id)).forEach((id) => picks.push({ kind: 'certificate', ref_id: id, options: null }));
  if (!picks.length) throw E.validation({ docs: 'Choose a valid value.' });

  const now = new Date();
  const ids = [];
  await knex.transaction(async (trx) => {
    for (const p of picks) {
      // Sharing the same document again replaces the earlier entry (e.g. a report with other sections).
      const q = trx('patient_documents').where({ business_id: ctx.businessId, appointment_id: v.a.id, kind: p.kind }).whereNull('revoked_at');
      if (p.ref_id) q.where('ref_id', p.ref_id); else q.whereNull('ref_id');
      await q.update({ revoked_at: now, updated_at: now }); // eslint-disable-line no-await-in-loop
      const [id] = await trx('patient_documents').insert({ business_id: ctx.businessId, appointment_id: v.a.id, ...p, locale, shared_by: ctx.userId || null }); // eslint-disable-line no-await-in-loop
      ids.push(id);
    }
    await audit.record(ctx, 'patient_docs.shared', { entityType: 'appointment', entityId: v.a.id, newValues: { documents: picks.map((p) => `${p.kind}${p.ref_id ? `#${p.ref_id}` : ''}`).join(', '), locale } }, trx);
  });

  let emailed = false;
  if (input.email !== '0' && v.a.patient_email && await mailer.configuredFor(ctx.businessId)) {
    const attachments = [];
    for (const p of picks) {
      const out = await render(ctx, v.a.id, p, locale); // eslint-disable-line no-await-in-loop
      attachments.push({ filename: out.filename, content: out.pdf, contentType: 'application/pdf' });
    }
    const clinic = await clinicInfo(ctx.businessId);
    await sendMail({ to: v.a.patient_email, clinic, locale, attachments, link: input.link || null, doctor: (locale === 'en' && v.doctor_name_en) || v.doctor_name });
    await knex('patient_documents').whereIn('id', ids).update({ emailed_at: new Date() });
    await audit.record(ctx, 'patient_docs.emailed', { entityType: 'appointment', entityId: v.a.id, newValues: { count: attachments.length } });
    emailed = true;
  }
  return { shared: picks.length, emailed };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function sendMail({ to, clinic, locale, attachments, link, doctor }) {
  const t = translator(locale);
  const c = brand.colors.light;
  const clinicName = (locale === 'en' && clinic.name_en) || clinic.name;
  const subject = t('patient_docs.mail.subject', { clinic: clinicName });
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const html = `<!doctype html><html dir="${dir}"><body style="margin:0;background:${c.background};font-family:Arial,Tahoma,sans-serif;color:${c.text}">
<div style="max-width:560px;margin:24px auto;background:${c.surface};border:1px solid ${c.border};border-radius:12px;padding:28px;text-align:${locale === 'ar' ? 'right' : 'left'}">
<div style="font-weight:700;font-size:16px;margin-bottom:18px">${esc(clinicName)}</div>
<h1 style="font-size:18px;margin:0 0 12px">${esc(subject)}</h1>
<p style="line-height:1.7;margin:0 0 12px">${esc(t('patient_docs.mail.intro', { doctor: doctor || '' }))}</p>
<ul style="line-height:1.8;margin:0 0 12px;padding-${locale === 'ar' ? 'right' : 'left'}:18px">${attachments.map((a) => `<li dir="ltr" style="text-align:${locale === 'ar' ? 'right' : 'left'}">${esc(a.filename)}</li>`).join('')}</ul>
${link ? `<p style="margin:16px 0 6px">${esc(t('patient_docs.mail.also_online'))}</p><p style="font-size:12px;word-break:break-all" dir="ltr"><a href="${esc(link)}" style="color:${c.primary}">${esc(link)}</a></p>` : ''}
<p style="font-size:12px;color:${c.textMuted};margin-top:20px">${esc(t('patient_docs.mail.foot'))}</p>
<div style="font-size:11px;color:${c.textMuted};margin-top:24px">${esc(brand.name)}</div></div></body></html>`;
  await mailer.send({ to, subject, html, replyTo: clinic.email || undefined, attachments, businessId: ctx.businessId, kind: 'patient_letters' });
}

async function revoke(ctx, apptId, docId) {
  const a = await appts.get(ctx, apptId);
  const n = await knex('patient_documents').where({ id: docId, business_id: ctx.businessId, appointment_id: a.id }).whereNull('revoked_at').update({ revoked_at: new Date(), updated_at: new Date() });
  if (!n) throw E.notFound('Document');
  await audit.record(ctx, 'patient_docs.revoked', { entityType: 'appointment', entityId: a.id, newValues: { document: docId } });
}

/** Label of a shared document for lists ("Prescription #12", "Consultation report", "Sick leave SL-2026-…"). */
function labelOf(doc, t, certs = []) {
  if (doc.kind === 'prescription') return t('patient_docs.rx_label', { n: doc.ref_id });
  if (doc.kind === 'report') return t('patient_docs.kinds.report');
  const c = certs.find((x) => x.id === doc.ref_id);
  return c ? `${t(`patient_docs.cert_types.${c.doc_type}`)} · ${c.serial}` : t('patient_docs.kinds.certificate');
}

/** Documents visible on the patient's consultation page (token-scoped). */
async function forPatient(businessId, apptId) {
  const rows = await sharedList(businessId, apptId);
  const certIds = rows.filter((r) => r.kind === 'certificate').map((r) => r.ref_id);
  const certs = certIds.length ? await knex('certificates').whereIn('id', certIds).where({ business_id: businessId }).select('id', 'doc_type', 'serial', 'revoked_at') : [];
  return { rows: rows.filter((r) => r.kind !== 'certificate' || certs.some((c) => c.id === r.ref_id && !c.revoked_at)), certs };
}

module.exports = { accentOf, orderPdf, KINDS, SECTIONS, ageOn, clinicInfo, visitInfo, choices, sharedList, render, share, revoke, labelOf, forPatient, certificatesService };
