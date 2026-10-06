// Document centre: each student has a checklist of documents (requested, uploaded, reviewed, expiring). Files are
// validated by content, stored privately and only served after a permission + scope check.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const uploads = require('../../core/uploads');
const { E } = require('../../core/errors');
const activity = require('../crm/activity.service');

const OPEN = ['missing', 'rejected', 'expired'];

/** The checklist rows a degree level usually needs (created as "missing" when an application opens). */
function standardSet(degree) {
  const base = ['passport', 'photo', 'transcript', 'certificate', 'ielts'];
  if (['master', 'phd'].includes(degree)) return [...base, 'cv', 'sop', 'recommendation'];
  if (degree === 'language') return ['passport', 'photo'];
  return [...base, 'sop'];
}

async function checklist(studentId) {
  const rows = await knex('documents as d').join('document_types as t', 't.key', 'd.type_key').leftJoin('media as m', 'm.id', 'd.media_id')
    .leftJoin('users as rv', 'rv.id', 'd.reviewed_by').leftJoin('users as up', 'up.id', 'd.uploaded_by').leftJoin('applications as a', 'a.id', 'd.application_id')
    .where('d.student_id', studentId)
    .select('d.*', 't.name_en as type_en', 't.name_ar as type_ar', 't.category', 't.has_expiry', 'm.original_name', 'm.size', 'm.mime', 'rv.name as reviewer_name', 'up.name as uploader_name', 'up.kind as uploader_kind', 'a.ref as application_ref')
    .orderBy('t.position').orderBy('d.id');
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((r) => ({ ...r, expiring: r.expiry_date && r.status === 'approved' && new Date(r.expiry_date) <= new Date(Date.now() + 30 * 86400000) && String(r.expiry_date) >= today }));
}

const summary = (list) => {
  const total = list.length;
  const approved = list.filter((d) => d.status === 'approved').length;
  return { total, approved, missing: list.filter((d) => OPEN.includes(d.status)).length, review: list.filter((d) => ['uploaded', 'under_review'].includes(d.status)).length, percent: total ? Math.round((approved / total) * 100) : 0 };
};

async function ensureChecklist(ctx, studentId, { degree, applicationId = null } = {}) {
  const have = new Set((await knex('documents').where({ student_id: studentId }).select('type_key')).map((r) => r.type_key));
  const missing = standardSet(degree).filter((k) => !have.has(k));
  if (missing.length) await knex('documents').insert(missing.map((k) => ({ student_id: studentId, type_key: k, status: 'missing', application_id: applicationId })));
  return missing.length;
}

async function get(id) {
  const d = await knex('documents as d').join('document_types as t', 't.key', 'd.type_key').where('d.id', id).first('d.*', 't.name_en as type_en', 't.name_ar as type_ar', 't.has_expiry');
  if (!d) throw E.notFound('Document');
  return d;
}

async function request(ctx, studentId, { typeKey, title = null, dueDate = null, applicationId = null, visaCaseId = null, note = null }) {
  const type = await knex('document_types').where({ key: typeKey, is_active: true }).first();
  if (!type) throw E.validation({ type_key: 'Choose a valid option.' });
  if (applicationId && !(await knex('applications').where({ id: applicationId, student_id: studentId }).first('id'))) throw E.validation({ application_id: 'Choose an application of this student.' });
  if (visaCaseId && !(await knex('visa_cases').where({ id: visaCaseId, student_id: studentId }).first('id'))) throw E.validation({ visa_case_id: 'Choose a visa case of this student.' });
  // Re-use an open row of the same type instead of duplicating it.
  const open = await knex('documents').where({ student_id: studentId, type_key: typeKey }).whereIn('status', OPEN).modify((q) => { if (title) q.where('title', title); }).first('id');
  const row = { requested_at: new Date(), requested_by: ctx.userId, due_date: dueDate || null, application_id: applicationId, visa_case_id: visaCaseId, notes: note || null, title: title || null };
  let id;
  if (open) { id = open.id; await knex('documents').where({ id }).update({ ...row, updated_at: new Date() }); }
  else [id] = await knex('documents').insert({ ...row, student_id: studentId, type_key: typeKey, status: 'missing' });
  await activity.log({ studentId, applicationId }, { type: 'document', title: 'document_requested', meta: { type: typeKey, type_en: type.name_en, type_ar: type.name_ar, due: dueDate }, actorId: ctx.userId, shareable: true });
  await audit.record(ctx, 'document.requested', { entityType: 'document', entityId: id, newValues: { student_id: studentId, type: typeKey, due_date: dueDate } });
  await events.emit('document.requested', { documentId: id, studentId, typeKey, typeName: { en: type.name_en, ar: type.name_ar }, dueDate, by: ctx.userId });
  return id;
}

/**
 * Stores an uploaded file on a checklist row (or a new row of `typeKey`). Staff uploads on behalf of the student are
 * marked as such. A new version of an approved document goes back to review.
 */
async function upload(ctx, studentId, file, { documentId = null, typeKey = null, expiryDate = null, byStudent = false, applicationId = null }) {
  let doc = documentId ? await knex('documents').where({ id: documentId, student_id: studentId }).first() : null;
  if (documentId && !doc) throw E.notFound('Document');
  const tk = doc ? doc.type_key : typeKey;
  const type = await knex('document_types').where({ key: tk, is_active: true }).first();
  if (!type) throw E.validation({ type_key: 'Choose a valid option.' });
  if (!doc) {
    doc = await knex('documents').where({ student_id: studentId, type_key: tk }).whereIn('status', OPEN).first();
  }
  const mediaId = await uploads.store(file, { purpose: 'document', allowed: uploads.DOCUMENTS, userId: ctx.userId, field: 'file' });
  const upd = { media_id: mediaId, status: 'uploaded', uploaded_at: new Date(), uploaded_by: ctx.userId, reviewed_at: null, reviewed_by: null, rejection_reason: null, expiry_date: expiryDate || (doc ? doc.expiry_date : null), updated_at: new Date() };
  let id;
  if (doc) {
    id = doc.id;
    const old = doc.media_id;
    await knex('documents').where({ id }).update({ ...upd, version: doc.version + 1 });
    if (old) await uploads.remove(old);
  } else {
    [id] = await knex('documents').insert({ ...upd, student_id: studentId, type_key: tk, version: 1, application_id: applicationId });
  }
  await activity.log({ studentId }, { type: 'document', title: byStudent ? 'document_uploaded_student' : 'document_uploaded_staff', meta: { type: tk, type_en: type.name_en, type_ar: type.name_ar }, actorId: ctx.userId, shareable: true });
  await audit.record(ctx, 'document.uploaded', { entityType: 'document', entityId: id, newValues: { student_id: studentId, type: tk, media_id: mediaId, by_student: byStudent } });
  await events.emit('document.uploaded', { documentId: id, studentId, typeKey: tk, byStudent, by: ctx.userId });
  return id;
}

async function review(ctx, documentId, { decision, reason = null, expiryDate = null }) {
  const d = await get(documentId);
  if (!['approve', 'reject', 'under_review'].includes(decision)) throw E.validation({ decision: 'Choose a valid option.' });
  if (!d.media_id && decision !== 'reject') throw E.validation({ decision: 'There is no file to review.' });
  if (decision === 'reject' && !reason) throw E.validation({ reason: 'Required.' });
  const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'under_review';
  await knex('documents').where({ id: documentId }).update({ status, reviewed_at: new Date(), reviewed_by: ctx.userId, rejection_reason: decision === 'reject' ? String(reason).slice(0, 500) : null, expiry_date: expiryDate || d.expiry_date, updated_at: new Date() });
  if (status !== 'under_review') {
    await activity.log({ studentId: d.student_id }, { type: 'document', title: status === 'approved' ? 'document_approved' : 'document_rejected', body: status === 'rejected' ? reason : null, meta: { type: d.type_key, type_en: d.type_en, type_ar: d.type_ar }, actorId: ctx.userId, shareable: true });
  }
  await audit.record(ctx, 'document.reviewed', { entityType: 'document', entityId: documentId, oldValues: { status: d.status }, newValues: { status, reason: reason || undefined } });
  await events.emit('document.reviewed', { documentId, studentId: d.student_id, status, reason, typeName: { en: d.type_en, ar: d.type_ar }, by: ctx.userId });
  // all required documents approved → move open applications from "Documents Pending" to "Documents Complete"
  if (status === 'approved') await events.emit('documents.maybe_complete', { studentId: d.student_id, ctx });
  return status;
}

async function remove(ctx, documentId) {
  const d = await get(documentId);
  await knex('documents').where({ id: documentId }).del();
  if (d.media_id) await uploads.remove(d.media_id);
  await audit.record(ctx, 'document.deleted', { entityType: 'document', entityId: documentId, oldValues: { student_id: d.student_id, type: d.type_key } });
}

/** Daily: approved documents past their expiry date become "expired" (and need a new upload). */
async function expireDue() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await knex('documents as d').join('document_types as t', 't.key', 'd.type_key').where('d.status', 'approved').whereNotNull('d.expiry_date').where('d.expiry_date', '<', today).select('d.id', 'd.student_id', 'd.type_key', 't.name_en', 't.name_ar');
  for (const r of rows) {
    await knex('documents').where({ id: r.id }).update({ status: 'expired', updated_at: new Date() }); // eslint-disable-line no-await-in-loop
    await activity.log({ studentId: r.student_id }, { type: 'document', title: 'document_expired', meta: { type: r.type_key, type_en: r.name_en, type_ar: r.name_ar }, shareable: true }); // eslint-disable-line no-await-in-loop
    await events.emit('document.expired', { documentId: r.id, studentId: r.student_id, typeName: { en: r.name_en, ar: r.name_ar } }); // eslint-disable-line no-await-in-loop
  }
  return rows.length;
}

module.exports = { checklist, summary, ensureChecklist, get, request, upload, review, remove, expireDue, standardSet, OPEN };
