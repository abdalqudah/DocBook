// Sending a document to a patient by link (WhatsApp click-to-chat, or copied into any message).
//   create(ctx, kind, refId, opts) — checks the document belongs to the signed-in clinic (and to a doctor login's own
//     patients) and that the member may see it, then makes a random token (only its SHA-256 is stored) valid for
//     LINK_DAYS days; returns { url, link, doc } with the patient's phone and a label for the message.
//     kind 'visit' (ref = appointment): one link to every document of that visit the sender may see (invoice,
//     prescriptions, report, orders, referrals, certificates, files), listed when the link is made.
//   resolve(token) — the live link (not expired, not withdrawn) or null.
// What a link opens: the document only — never the rest of the patient's record.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');

const KINDS = ['invoice', 'prescription', 'report', 'certificate', 'order', 'referral', 'file', 'visit'];
const LINK_DAYS = 30;
// Who may send which document (any one of the permissions).
const PERMS = {
  invoice: ['billing.view'], prescription: ['clinical.view'], report: ['clinical.view'], certificate: ['certificates.view', 'certificates.issue'],
  order: ['clinical.view'], referral: ['clinical.view'], file: ['clinical.view'], visit: ['clinical.view', 'billing.view'],
};
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const may = (ctx, kind) => (PERMS[kind] || []).some((p) => ctx.permissions && ctx.permissions.has(p));

/** The document being shared: who it is for and how to name it in the message. */
async function target(ctx, kind, refId, opts = {}) {
  const id = Number(refId) || 0;
  if (kind === 'invoice') {
    const inv = await knex('invoices as i').leftJoin('patients as p', 'p.id', 'i.patient_id').where({ 'i.business_id': ctx.businessId, 'i.id': id })
      .first('i.id', 'i.invoice_number', 'i.patient_id', 'i.appointment_id', 'i.patient_name', 'i.doctor_id', 'p.phone as phone', 'p.full_name as full_name');
    if (!inv || (ctx.ownDoctorId && inv.doctor_id !== ctx.ownDoctorId)) throw E.notFound('Invoice');
    const appt = !inv.phone && inv.appointment_id ? await knex('appointments').where({ id: inv.appointment_id, business_id: ctx.businessId }).first('patient_phone') : null;
    return { appointment_id: inv.appointment_id, patient_id: inv.patient_id, name: inv.full_name || inv.patient_name, phone: inv.phone || (appt && appt.patient_phone), label: { n: inv.invoice_number } };
  }
  if (kind === 'prescription') {
    const rx = await require('../clinic/clinical.service').prescription(ctx, id); // eslint-disable-line global-require
    return { appointment_id: rx.appointment_id, patient_id: rx.patient_id, name: rx.patient_name, phone: rx.patient_phone };
  }
  if (kind === 'report') {
    const a = await require('../clinic/appointments.service').get(ctx, id); // eslint-disable-line global-require
    if (!(await knex('consultations').where({ business_id: ctx.businessId, appointment_id: a.id }).first('id'))) throw E.notFound('Report');
    return { appointment_id: a.id, patient_id: a.patient_id, name: a.patient_name, phone: a.patient_phone, options: { sections: (() => { const all = require('../patientdocs/documents').REPORT_SECTIONS; const pick = [].concat(opts.sections || []).filter((x) => all.includes(x)); return pick.length ? pick : all; })() } }; // eslint-disable-line global-require
  }
  if (kind === 'certificate') {
    const cert = await require('../certificates/certificates.service').get(ctx, id); // eslint-disable-line global-require
    if (cert.revoked_at) throw new AppError('SHARE_REVOKED_DOC', 'This document was revoked.', 409);
    const a = cert.appointment_id ? await knex('appointments').where({ id: cert.appointment_id, business_id: ctx.businessId }).first('patient_phone') : null;
    const p = cert.patient_id ? await knex('patients').where({ id: cert.patient_id, business_id: ctx.businessId }).first('phone') : null;
    return { appointment_id: cert.appointment_id, patient_id: cert.patient_id, name: cert.patient_name, phone: (p && p.phone) || (a && a.patient_phone), label: { type: cert.doc_type } };
  }
  if (kind === 'order' || kind === 'referral') {
    const orders = require('../orders/orders.service'); // eslint-disable-line global-require
    const d = kind === 'order' ? await orders.getOrder(ctx, id) : await orders.getReferral(ctx, id);
    return { appointment_id: d.appointment_id, patient_id: d.patient_id, name: d.patient_full_name || d.patient_name, phone: d.patient_phone, label: kind === 'order' ? { kind: d.kind } : { specialty: d.specialty } };
  }
  if (kind === 'file') {
    const f = await knex('patient_files as f').join('patients as p', 'p.id', 'f.patient_id').where({ 'f.business_id': ctx.businessId, 'f.id': id }).first('f.id', 'f.patient_id', 'f.appointment_id', 'f.title', 'f.name', 'p.full_name', 'p.phone');
    if (!f) throw E.notFound('File');
    await require('../orders/orders.service').patientOf(ctx, f.patient_id); // eslint-disable-line global-require -- doctor scope
    return { appointment_id: f.appointment_id, patient_id: f.patient_id, name: f.full_name, phone: f.phone, label: { title: f.title || f.name } };
  }
  if (kind === 'visit') {
    const a = await knex('appointments as a').leftJoin('patients as p', 'p.id', 'a.patient_id').where({ 'a.business_id': ctx.businessId, 'a.id': id }).whereNot('a.appointment_type', 'blocked')
      .first('a.id', 'a.patient_id', 'a.doctor_id', 'a.patient_name', 'a.patient_phone', 'a.patient_email', 'a.appointment_date', 'p.full_name', 'p.phone', 'p.email');
    if (!a || (ctx.ownDoctorId && a.doctor_id !== ctx.ownDoctorId)) throw E.notFound('Appointment');
    return { appointment_id: a.id, patient_id: a.patient_id, name: a.full_name || a.patient_name, phone: a.phone || a.patient_phone, email: a.email || a.patient_email, label: { date: String(a.appointment_date).slice(0, 10) } };
  }
  throw E.notFound('Document');
}

/**
 * The documents of a visit, as far as this member may see them (clinical ones only with access to the record).
 * [{ kind, id, label, options? }] in a fixed order: invoice, prescriptions, report, orders, referrals, certificates, files.
 */
async function visitItems(ctx, apptId, { clinical = true } = {}) {
  const has = (k) => may(ctx, k);
  const w = { business_id: ctx.businessId, appointment_id: apptId };
  const clin = clinical && has('prescription');
  const [invs, rxs, consult, ords, refs, certs, files] = await Promise.all([
    has('invoice') ? knex('invoices').where(w).orderBy('id').select('id', 'invoice_number') : [],
    clin ? knex('prescriptions').where(w).orderBy('id').select('id') : [],
    clin ? knex('consultations').where(w).first('id') : null,
    clin ? knex('medical_orders').where(w).orderBy('id').select('id', 'kind') : [],
    clin ? knex('referrals').where(w).orderBy('id').select('id', 'specialty') : [],
    clinical && has('certificate') ? knex('certificates').where(w).whereNull('revoked_at').orderBy('id').select('id', 'doc_type') : [],
    clin ? knex('patient_files').where(w).orderBy('id').select('id', 'title', 'name') : [],
  ]);
  return [
    ...invs.map((r) => ({ kind: 'invoice', id: r.id, label: { n: r.invoice_number } })),
    ...rxs.map((r) => ({ kind: 'prescription', id: r.id, label: {} })),
    ...(consult ? [{ kind: 'report', id: apptId, label: {}, options: { sections: require('../patientdocs/documents').REPORT_SECTIONS } }] : []), // eslint-disable-line global-require
    ...ords.map((r) => ({ kind: 'order', id: r.id, label: { kind: r.kind } })),
    ...refs.map((r) => ({ kind: 'referral', id: r.id, label: { specialty: r.specialty } })),
    ...certs.map((r) => ({ kind: 'certificate', id: r.id, label: { type: r.doc_type } })),
    ...files.map((r) => ({ kind: 'file', id: r.id, label: { title: r.title || r.name } })),
  ];
}

/** The patient's e-mail for a shared document (the patient file first, then the appointment). */
async function emailOf(ctx, doc) {
  if (doc.email) return doc.email;
  const p = doc.patient_id ? await knex('patients').where({ id: doc.patient_id, business_id: ctx.businessId }).first('email') : null;
  if (p && p.email) return p.email;
  const a = doc.appointment_id ? await knex('appointments').where({ id: doc.appointment_id, business_id: ctx.businessId }).first('patient_email') : null;
  return (a && a.patient_email) || null;
}

async function create(ctx, kind, refId, { opts = {}, locale = 'ar', base = '', needEmail = false } = {}) {
  if (!KINDS.includes(kind)) throw E.notFound('Document');
  if (!may(ctx, kind)) throw E.forbidden(PERMS[kind][0]);
  const doc = await target(ctx, kind, refId, opts);
  let clinical = true;
  if (doc.patient_id) {
    const acc = await require('../clinicalplus/privacy.service').access(ctx, { patientId: doc.patient_id }); // eslint-disable-line global-require
    clinical = Boolean(acc.clinical);
    if (kind !== 'invoice' && kind !== 'visit' && !clinical) throw new AppError('RECORD_RESTRICTED', 'Restricted.', 403);
  }
  if (kind === 'visit') {
    const items = await visitItems(ctx, doc.appointment_id, { clinical });
    if (!items.length) throw new AppError('SHARE_EMPTY', 'This visit has no documents yet.', 409);
    doc.options = { items };
  }
  doc.email = await emailOf(ctx, doc);
  if (needEmail && !doc.email) throw new AppError('SHARE_NO_EMAIL', 'The patient has no e-mail address.', 422);
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + LINK_DAYS * 86_400_000);
  const [id] = await knex('share_links').insert({
    business_id: ctx.businessId, token_hash: hash(token), kind, ref_id: Number(refId), appointment_id: doc.appointment_id || null, patient_id: doc.patient_id || null,
    options: doc.options ? JSON.stringify(doc.options) : null, locale: locale === 'en' ? 'en' : 'ar', created_by: ctx.userId || null, expires_at: expires,
  });
  await audit.record(ctx, 'share.link_created', { entityType: kind, entityId: Number(refId), newValues: { link_id: id, expires: expires.toISOString().slice(0, 10) } });
  return { id, url: `${base}/d/${token}`, expires, doc };
}

async function resolve(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  const row = await knex('share_links').where({ token_hash: hash(token) }).first();
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return null;
  return { ...row, options: row.options ? JSON.parse(row.options) : {} };
}

async function opened(row) {
  await knex('share_links').where({ id: row.id }).update({ opens: knex.raw('opens + 1'), last_opened_at: new Date() });
}

/** Withdraws every live link of a document (e.g. after a certificate was revoked). */
async function revokeFor(ctx, kind, refId) {
  const n = await knex('share_links').where({ business_id: ctx.businessId, kind, ref_id: Number(refId) }).whereNull('revoked_at').update({ revoked_at: new Date() });
  if (n) await audit.record(ctx, 'share.links_revoked', { entityType: kind, entityId: Number(refId), newValues: { links: n } });
  return n;
}

module.exports = { KINDS, LINK_DAYS, PERMS, create, resolve, opened, revokeFor, target, visitItems, hash };
