// Sending a document to a patient by link (WhatsApp click-to-chat, or copied into any message).
//   create(ctx, kind, refId, opts) — checks the document belongs to the signed-in clinic (and to a doctor login's own
//     patients) and that the member may see it, then makes a random token (only its SHA-256 is stored) valid for
//     LINK_DAYS days; returns { url, link, doc } with the patient's phone and a label for the message.
//   resolve(token) — the live link (not expired, not withdrawn) or null.
// What a link opens: the document only — never the rest of the patient's record.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');

const KINDS = ['invoice', 'prescription', 'report', 'certificate', 'order', 'referral', 'file'];
const LINK_DAYS = 30;
// Who may send which document (any one of the permissions).
const PERMS = {
  invoice: ['billing.view'], prescription: ['clinical.view'], report: ['clinical.view'], certificate: ['certificates.view', 'certificates.issue'],
  order: ['clinical.view'], referral: ['clinical.view'], file: ['clinical.view'],
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
  throw E.notFound('Document');
}

async function create(ctx, kind, refId, { opts = {}, locale = 'ar', base = '' } = {}) {
  if (!KINDS.includes(kind)) throw E.notFound('Document');
  if (!may(ctx, kind)) throw E.forbidden(PERMS[kind][0]);
  const doc = await target(ctx, kind, refId, opts);
  if (doc.patient_id) {
    const acc = await require('../clinicalplus/privacy.service').access(ctx, { patientId: doc.patient_id }); // eslint-disable-line global-require
    if (kind !== 'invoice' && !acc.clinical) throw new AppError('RECORD_RESTRICTED', 'Restricted.', 403);
  }
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

module.exports = { KINDS, LINK_DAYS, PERMS, create, resolve, opened, revokeFor, target, hash };
