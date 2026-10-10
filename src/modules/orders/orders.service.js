// Lab & imaging orders, referral letters and the patient's files.
//   • The clinic keeps its own list of lab tests and imaging studies (order_catalog); a starter list can be added and
//     edited. An order stores the names it was written with, so editing the list never changes an old order.
//   • An order or a referral is written from a visit (the visit's patient and doctor); both print on the clinic's
//     letterhead with the doctor's signature and the clinic stamp (the stamp follows the "reports" setting).
//   • Patient files: scanned paper forms, lab results, imaging reports … (PDF, JPG, PNG up to 10 MB), stored in the
//     database with the patient, optionally linked to a visit or an order. Never trusted by name: the type is read
//     from the first bytes.
//   • Every id is checked against the signed-in clinic (ctx.businessId); a doctor login sees only its own patients.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, optionalString } = require('../../core/validate');
const { E, AppError } = require('../../core/errors');
const appts = require('../clinic/appointments.service');
const lib = require('../clinic/records.lib');
const { sniff } = require('../telehealth/telehealth.service');

const KINDS = ['lab', 'imaging'];
const URGENCY = ['routine', 'urgent'];
const STATUSES = ['ordered', 'done', 'cancelled'];
const FILE_CATEGORIES = ['scan', 'lab_result', 'imaging', 'report', 'other'];
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const FILE_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const parse = (v, d) => { if (!v) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };

// ---------------------------------------------------------------- catalog
// [kind, Arabic name, English name, code]
const STARTER = [
  ['lab', 'صورة دم كاملة', 'Complete blood count (CBC)', 'CBC'],
  ['lab', 'سكر صائم', 'Fasting blood sugar', 'FBS'],
  ['lab', 'السكر التراكمي', 'HbA1c', 'HBA1C'],
  ['lab', 'فحص الدهون', 'Lipid profile', 'LIPID'],
  ['lab', 'وظائف الكلى', 'Kidney function tests', 'KFT'],
  ['lab', 'وظائف الكبد', 'Liver function tests', 'LFT'],
  ['lab', 'هرمون الغدة الدرقية', 'Thyroid stimulating hormone (TSH)', 'TSH'],
  ['lab', 'تحليل البول العام', 'Urinalysis', 'UA'],
  ['lab', 'تحليل البراز', 'Stool analysis', 'STOOL'],
  ['lab', 'فيتامين د', 'Vitamin D (25-OH)', 'VITD'],
  ['lab', 'فيتامين ب12', 'Vitamin B12', 'B12'],
  ['lab', 'مخزون الحديد', 'Ferritin', 'FERR'],
  ['lab', 'البروتين التفاعلي', 'C-reactive protein (CRP)', 'CRP'],
  ['lab', 'سرعة الترسيب', 'Erythrocyte sedimentation rate (ESR)', 'ESR'],
  ['lab', 'الأملاح', 'Electrolytes', 'LYTES'],
  ['lab', 'حمض اليوريك', 'Uric acid', 'UA-ACID'],
  ['lab', 'سيولة الدم', 'PT / INR', 'PT-INR'],
  ['lab', 'فحص الحمل بالدم', 'Pregnancy test (β-hCG)', 'BHCG'],
  ['imaging', 'صورة أشعة للصدر', 'Chest X-ray', 'CXR'],
  ['imaging', 'صورة أشعة عادية', 'Plain X-ray', 'XR'],
  ['imaging', 'ألتراساوند البطن', 'Abdominal ultrasound', 'US-ABD'],
  ['imaging', 'ألتراساوند الحوض', 'Pelvic ultrasound', 'US-PEL'],
  ['imaging', 'ألتراساوند الغدة الدرقية', 'Thyroid ultrasound', 'US-THY'],
  ['imaging', 'تخطيط القلب', 'Electrocardiogram (ECG)', 'ECG'],
  ['imaging', 'إيكو القلب', 'Echocardiogram', 'ECHO'],
  ['imaging', 'طبقي محوري للدماغ', 'CT brain', 'CT-BR'],
  ['imaging', 'طبقي محوري للبطن', 'CT abdomen', 'CT-ABD'],
  ['imaging', 'رنين مغناطيسي للدماغ', 'MRI brain', 'MRI-BR'],
  ['imaging', 'رنين مغناطيسي للعمود القطني', 'MRI lumbar spine', 'MRI-LS'],
  ['imaging', 'تصوير الثدي', 'Mammogram', 'MAMMO'],
  ['imaging', 'صورة بانوراما للأسنان', 'Dental panoramic (OPG)', 'OPG'],
  ['imaging', 'كثافة العظام', 'Bone density (DEXA)', 'DEXA'],
];

async function seed(businessId) {
  const [{ n }] = await knex('order_catalog').where({ business_id: businessId }).count({ n: '*' });
  if (Number(n) > 0) return false;
  await knex('order_catalog').insert(STARTER.map(([kind, name, nameEn, code], i) => ({ business_id: businessId, kind, name, name_en: nameEn, code, sort_order: i })));
  return true;
}

const catalog = (businessId, { activeOnly = false } = {}) => {
  const q = knex('order_catalog').where({ business_id: businessId }).orderBy([{ column: 'kind' }, { column: 'sort_order' }, { column: 'name' }]);
  if (activeOnly) q.where({ is_active: true });
  return q;
};

const bool = () => z.preprocess((v) => v === '1' || v === 'on' || v === true, z.boolean());
const itemSchema = z.object({
  kind: z.enum(KINDS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  name: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(160),
  name_en: optionalString(160), code: optionalString(40), category: optionalString(80), is_active: bool(),
});

async function saveItem(ctx, id, input) {
  const d = validate(itemSchema, input || {});
  const row = { kind: d.kind, name: d.name, name_en: d.name_en || null, code: d.code || null, category: d.category || null, is_active: d.is_active, updated_at: new Date() };
  const clash = await knex('order_catalog').where({ business_id: ctx.businessId, kind: d.kind, name: d.name }).modify((q) => { if (id) q.whereNot({ id }); }).first('id');
  if (clash) throw E.validation({ name: 'This name is already in the list.' });
  if (id) {
    const before = await knex('order_catalog').where({ id, business_id: ctx.businessId }).first();
    if (!before) throw E.notFound('Item');
    await knex('order_catalog').where({ id: before.id, business_id: ctx.businessId }).update(row);
    await audit.record(ctx, 'order_catalog.updated', { entityType: 'order_catalog', entityId: before.id, oldValues: { name: before.name, is_active: Boolean(before.is_active) }, newValues: { name: d.name, is_active: d.is_active } });
    return before.id;
  }
  const [newId] = await knex('order_catalog').insert({ ...row, business_id: ctx.businessId });
  await audit.record(ctx, 'order_catalog.created', { entityType: 'order_catalog', entityId: newId, newValues: { kind: d.kind, name: d.name } });
  return newId;
}

async function removeItem(ctx, id) {
  const row = await knex('order_catalog').where({ id, business_id: ctx.businessId }).first();
  if (!row) throw E.notFound('Item');
  await knex('order_catalog').where({ id: row.id, business_id: ctx.businessId }).del();
  await audit.record(ctx, 'order_catalog.deleted', { entityType: 'order_catalog', entityId: row.id, oldValues: { kind: row.kind, name: row.name } });
}

// ---------------------------------------------------------------- orders
const orderSchema = z.object({
  kind: z.enum(KINDS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  urgency: z.preprocess((v) => (v ? v : 'routine'), z.enum(URGENCY)),
  notes: optionalString(2000),
});

/** Writes a lab / imaging order from a visit: tests[] are catalog ids of this clinic; `other` adds free lines. */
async function createOrder(ctx, apptId, input = {}) {
  const a = await appts.get(ctx, apptId); // the clinic's own appointment; a doctor login only its own
  if (a.appointment_type === 'blocked' || !a.patient_id) throw E.notFound('Appointment');
  const d = validate(orderSchema, input);
  const ids = [].concat(input.tests || []).flatMap((v) => String(v).split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const found = ids.length ? await knex('order_catalog').where({ business_id: ctx.businessId, kind: d.kind }).whereIn('id', ids).select('id', 'name', 'name_en', 'code') : [];
  const picked = ids.map((i) => found.find((r) => r.id === i)).filter(Boolean); // in the order they were ticked
  const free = String(input.other || '').split(/\r?\n/).map((s) => s.trim().slice(0, 160)).filter(Boolean).slice(0, 20);
  const items = [...picked.map((r) => ({ name: r.name, name_en: r.name_en || null, code: r.code || null })), ...free.map((name) => ({ name, name_en: null, code: null }))];
  if (!items.length) throw E.validation({ tests: 'Choose at least one test.' });
  const [id] = await knex('medical_orders').insert({
    business_id: ctx.businessId, patient_id: a.patient_id, appointment_id: a.id, doctor_id: a.doctor_id, kind: d.kind, items: JSON.stringify(items),
    urgency: d.urgency, notes: d.notes || null, status: 'ordered', patient_name: a.patient_name, created_by: ctx.userId,
  });
  await audit.record(ctx, 'medical_order.created', { entityType: 'medical_order', entityId: id, newValues: { appointment_id: a.id, kind: d.kind, items: items.length, urgency: d.urgency } });
  return id;
}

const DOC_COLS = ['d.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.specialization', 'd.specialization_en', 'd.license_number'];
const PAT_COLS = ['p.gender', 'p.date_of_birth', 'p.phone as patient_phone', 'p.full_name as patient_full_name'];

async function getOrder(ctx, id) {
  const o = await knex('medical_orders as o').leftJoin('doctors as d', 'd.id', 'o.doctor_id').leftJoin('patients as p', 'p.id', 'o.patient_id')
    .where({ 'o.business_id': ctx.businessId, 'o.id': id }).first('o.*', ...DOC_COLS, ...PAT_COLS);
  if (!o || (ctx.ownDoctorId && o.doctor_id !== ctx.ownDoctorId)) throw E.notFound('Order');
  return { ...o, items: parse(o.items, []) };
}

const listOrders = (ctx, where) => {
  const q = knex('medical_orders as o').leftJoin('doctors as d', 'd.id', 'o.doctor_id').where({ 'o.business_id': ctx.businessId, ...where }).orderBy('o.id', 'desc').limit(200)
    .select('o.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en');
  if (ctx.ownDoctorId) q.where('o.doctor_id', ctx.ownDoctorId);
  return q.then((rows) => rows.map((r) => ({ ...r, items: parse(r.items, []) })));
};
const ordersForVisit = (ctx, apptId) => listOrders(ctx, { 'o.appointment_id': apptId });
const ordersForPatient = (ctx, patientId) => listOrders(ctx, { 'o.patient_id': patientId });

/** Marks an order done (with an optional result note) or cancelled; a done / cancelled order can be reopened. */
async function setOrderStatus(ctx, id, input = {}) {
  const o = await getOrder(ctx, id);
  const d = validate(z.object({ status: z.enum(STATUSES, { errorMap: () => ({ message: 'Choose a valid value.' }) }), result_note: optionalString(4000) }), input);
  const patch = { status: d.status, result_note: d.result_note ?? o.result_note ?? null, done_at: d.status === 'done' ? new Date() : null, updated_at: new Date() };
  await knex('medical_orders').where({ id: o.id, business_id: ctx.businessId }).update(patch);
  await audit.record(ctx, 'medical_order.status', { entityType: 'medical_order', entityId: o.id, oldValues: { status: o.status }, newValues: { status: d.status, result_note: Boolean(patch.result_note) } });
}

// ---------------------------------------------------------------- referrals
const referralSchema = z.object({
  specialty: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(120),
  to_doctor: optionalString(160), to_facility: optionalString(160),
  urgency: z.preprocess((v) => (v ? v : 'routine'), z.enum(URGENCY)),
  reason: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(3000),
  summary: optionalString(6000),
});

async function createReferral(ctx, apptId, input = {}) {
  const a = await appts.get(ctx, apptId);
  if (a.appointment_type === 'blocked' || !a.patient_id) throw E.notFound('Appointment');
  const d = validate(referralSchema, input);
  const [id] = await knex('referrals').insert({
    business_id: ctx.businessId, patient_id: a.patient_id, appointment_id: a.id, doctor_id: a.doctor_id, specialty: d.specialty, to_doctor: d.to_doctor || null,
    to_facility: d.to_facility || null, urgency: d.urgency, reason: d.reason, summary: d.summary || null, patient_name: a.patient_name, created_by: ctx.userId,
  });
  await audit.record(ctx, 'referral.created', { entityType: 'referral', entityId: id, newValues: { appointment_id: a.id, specialty: d.specialty, urgency: d.urgency } });
  return id;
}

async function getReferral(ctx, id) {
  const r = await knex('referrals as r').leftJoin('doctors as d', 'd.id', 'r.doctor_id').leftJoin('patients as p', 'p.id', 'r.patient_id')
    .where({ 'r.business_id': ctx.businessId, 'r.id': id }).first('r.*', ...DOC_COLS, ...PAT_COLS);
  if (!r || (ctx.ownDoctorId && r.doctor_id !== ctx.ownDoctorId)) throw E.notFound('Referral');
  return r;
}

const listReferrals = (ctx, where) => {
  const q = knex('referrals as r').leftJoin('doctors as d', 'd.id', 'r.doctor_id').where({ 'r.business_id': ctx.businessId, ...where }).orderBy('r.id', 'desc').limit(200)
    .select('r.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en');
  if (ctx.ownDoctorId) q.where('r.doctor_id', ctx.ownDoctorId);
  return q;
};
const referralsForVisit = (ctx, apptId) => listReferrals(ctx, { 'r.appointment_id': apptId });
const referralsForPatient = (ctx, patientId) => listReferrals(ctx, { 'r.patient_id': patientId });

// ---------------------------------------------------------------- patient files
/** The patient (of this clinic, and of this doctor for a doctor login) or 404. */
async function patientOf(ctx, patientId) {
  const q = knex('patients').where({ 'patients.business_id': ctx.businessId, 'patients.id': patientId }).first('patients.id', 'patients.full_name');
  lib.scopePatientsToDoctor(q, ctx.ownDoctorId);
  require('../clinic/branches.service').scopePatients(q, ctx); // eslint-disable-line global-require
  const p = await q;
  if (!p) throw E.notFound('Patient');
  return p;
}

/** Checks multer memory files; returns rows to store or throws a 422 with a code. */
function checkFiles(files) {
  const list = (files || []).filter((f) => f && f.buffer && f.size > 0);
  if (!list.length) throw new AppError('FILE_REQUIRED', 'Choose a file.', 422, { files: 'FILE_REQUIRED' });
  if (list.length > MAX_FILES) throw new AppError('FILE_TOO_MANY', 'Too many files.', 422, { files: 'FILE_TOO_MANY' });
  return list.map((f) => {
    if (f.buffer.length > MAX_FILE_BYTES) throw new AppError('FILE_TOO_BIG', 'File too large.', 422, { files: 'FILE_TOO_BIG' });
    const kind = sniff(f.buffer);
    if (!kind) throw new AppError('FILE_TYPE', 'Unsupported file type.', 422, { files: 'FILE_TYPE' });
    const base = String(f.originalname || 'file').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim().slice(0, 100) || 'file';
    return { name: `${base}.${kind}`, mime: FILE_TYPES[kind], size: f.buffer.length, sha256: crypto.createHash('sha256').update(f.buffer).digest('hex'), data: f.buffer };
  });
}

async function addFiles(ctx, patientId, files, input = {}) {
  const p = await patientOf(ctx, patientId);
  const rows = checkFiles(files);
  await require('../storage/storage.service').assertRoom(ctx.businessId, rows.reduce((n, r) => n + r.size, 0)); // eslint-disable-line global-require
  const category = FILE_CATEGORIES.includes(input.category) ? input.category : 'scan';
  const title = String(input.title || '').trim().slice(0, 160) || null;
  // A visit or an order of this patient only.
  const apptId = Number(input.appointment_id) || null;
  const appt = apptId ? await knex('appointments').where({ id: apptId, business_id: ctx.businessId, patient_id: p.id }).first('id') : null;
  const orderId = Number(input.order_id) || null;
  const order = orderId ? await knex('medical_orders').where({ id: orderId, business_id: ctx.businessId, patient_id: p.id }).first('id', 'appointment_id') : null;
  const ids = [];
  await knex.transaction(async (trx) => {
    for (const r of rows) {
      const [id] = await trx('patient_files').insert({ // eslint-disable-line no-await-in-loop
        ...r, business_id: ctx.businessId, patient_id: p.id, appointment_id: (appt && appt.id) || (order && order.appointment_id) || null, order_id: order ? order.id : null,
        category, title, created_by: ctx.userId,
      });
      ids.push(id);
    }
    await audit.record(ctx, 'patient_file.added', { entityType: 'patient', entityId: p.id, newValues: { files: rows.map((r) => r.name), category, order_id: order ? order.id : null } }, trx);
  });
  return ids;
}

const FILE_COLS = ['f.id', 'f.patient_id', 'f.appointment_id', 'f.order_id', 'f.category', 'f.title', 'f.name', 'f.mime', 'f.size', 'f.created_at', 'u.name as added_by'];
async function filesForPatient(ctx, patientId) {
  const p = await patientOf(ctx, patientId);
  return knex('patient_files as f').leftJoin('users as u', 'u.id', 'f.created_by').where({ 'f.business_id': ctx.businessId, 'f.patient_id': p.id }).orderBy('f.id', 'desc').limit(300).select(FILE_COLS);
}

async function fileOf(ctx, patientId, fileId) {
  const p = await patientOf(ctx, patientId);
  const f = await knex('patient_files').where({ id: fileId, business_id: ctx.businessId, patient_id: p.id }).first();
  if (!f) throw E.notFound('File');
  return f;
}

async function removeFile(ctx, patientId, fileId) {
  const f = await fileOf(ctx, patientId, fileId);
  await knex('patient_files').where({ id: f.id, business_id: ctx.businessId }).del();
  await audit.record(ctx, 'patient_file.deleted', { entityType: 'patient', entityId: f.patient_id, oldValues: { name: f.name, category: f.category, sha256: f.sha256 } });
}

// ---------------------------------------------------------------- report
/** Clinical figures for a date range: tests ordered, referrals by specialty, files added. */
async function report(ctx, from, to) {
  const range = (q, col) => q.where(col, '>=', `${from} 00:00:00`).where(col, '<=', `${to} 23:59:59`);
  // a doctor login: their own; the branch chosen in the account menu: by the visit's branch
  const own = (q, col) => require('../clinic/branches.service').scopeByVisit(ctx.ownDoctorId && col ? q.where(col, ctx.ownDoctorId) : q, ctx, 'appointment_id'); // eslint-disable-line global-require
  const orders = await own(range(knex('medical_orders').where({ business_id: ctx.businessId }), 'created_at'), 'doctor_id').select('kind', 'items', 'status');
  const tests = new Map();
  const byKind = { lab: 0, imaging: 0 };
  const byStatus = { ordered: 0, done: 0, cancelled: 0 };
  for (const o of orders) {
    byKind[o.kind] = (byKind[o.kind] || 0) + 1;
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    for (const it of parse(o.items, [])) {
      const k = `${o.kind}|${it.name}`;
      const cur = tests.get(k) || { kind: o.kind, name: it.name, name_en: it.name_en, n: 0 };
      cur.n += 1; tests.set(k, cur);
    }
  }
  const [referrals, files] = await Promise.all([
    own(range(knex('referrals').where({ business_id: ctx.businessId }), 'created_at'), 'doctor_id').groupBy('specialty').select('specialty').count({ n: '*' }).orderBy('n', 'desc'),
    own(range(knex('patient_files').where({ business_id: ctx.businessId }), 'created_at'), null).groupBy('category').select('category').count({ n: '*' }),
  ]);
  return {
    orders: orders.length, byKind, byStatus,
    tests: [...tests.values()].sort((a, b) => b.n - a.n).slice(0, 30),
    referrals: referrals.map((r) => ({ specialty: r.specialty, n: Number(r.n) })),
    files: Object.fromEntries(files.map((r) => [r.category, Number(r.n)])),
  };
}

module.exports = {
  KINDS, URGENCY, STATUSES, FILE_CATEGORIES, MAX_FILE_BYTES, MAX_FILES, STARTER,
  seed, catalog, saveItem, removeItem,
  createOrder, getOrder, ordersForVisit, ordersForPatient, setOrderStatus,
  createReferral, getReferral, referralsForVisit, referralsForPatient,
  patientOf, checkFiles, addFiles, filesForPatient, fileOf, removeFile, report,
};
