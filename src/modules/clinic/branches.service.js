// Clinic branches. The main branch is the clinic itself (its name, address and phone from Settings → Clinic); rows in
// clinic_branches are the other branches, and branch_id NULL means "main branch" on doctors and appointments.
// How many branches a clinic may run comes from its package (subscriptions.branchAllowance: the main branch counts).
//   • a doctor works in one branch (doctors.branch_id); an appointment takes place in a branch (appointments.branch_id):
//     the doctor's branch when a doctor is set, else the branch the patient chose (a booking with "any doctor").
//   • every id is checked against the signed-in clinic (ctx.businessId) — never trusted from the form alone.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const cache = require('../../core/cache');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { E, AppError } = require('../../core/errors');

const httpsUrl = () => z.preprocess(emptyToUndefined, z.string().trim().max(500).url('Enter a valid URL.').refine((v) => /^https:\/\//i.test(v), 'Use an https:// URL.').optional());
const schema = z.object({
  name: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(120),
  name_en: optionalString(120), short_name: optionalString(40), city: optionalString(120), address: optionalString(255),
  phone: z.preprocess(emptyToUndefined, z.string().trim().max(40).regex(/^[+0-9\s()-]{6,40}$/, 'Enter a valid phone number.').optional()),
  whatsapp: z.preprocess(emptyToUndefined, z.string().trim().max(40).regex(/^[+0-9\s()-]{6,40}$/, 'Enter a valid phone number.').optional()),
  map_url: httpsUrl(),
  sort_order: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(0).max(9999)),
});

const forget = (businessId) => cache.forgetPrefix(`branches:${businessId}:`);

/** The clinic's branch rows (main branch not included), cached briefly — the public pages read them on every view. */
const list = (businessId, { activeOnly = false } = {}) => cache.remember(`branches:${businessId}:${activeOnly ? 'a' : 'all'}`, () => {
  const q = knex('clinic_branches').where({ business_id: businessId }).orderBy([{ column: 'sort_order' }, { column: 'id' }]);
  if (activeOnly) q.where({ is_active: true });
  return q;
}, 30_000);

/** Does the clinic run more than its main branch right now? */
const multi = async (businessId) => (await list(businessId, { activeOnly: true })).length > 0;

const nameOf = (row, locale) => (locale === 'en' && row.name_en) || row.name;

/**
 * Choices for a select: the main branch (value '') and the active branches. `clinic` is the clinic row; its own name
 * is used for the main branch with "(main)".
 */
async function options(clinic, t, locale, { includeInactive = false } = {}) {
  const rows = await list(clinic.id, { activeOnly: !includeInactive });
  return [{ value: '', label: t('branches.main_named', { name: (locale === 'en' && clinic.name_en) || clinic.name }), short: clinic.branch_short || null },
    ...rows.map((r) => ({ value: String(r.id), label: nameOf(r, locale) + (r.is_active ? '' : ` (${t('branches.inactive')})`), short: r.short_name || null }))];
}

/** Label of a branch id (null = main) for lists. */
function labelOf(rows, id, t, locale) {
  if (!id) return t('branches.main');
  const r = rows.find((x) => x.id === Number(id));
  return r ? nameOf(r, locale) : '—';
}

/** An active branch of this clinic, or a validation error; '' / null / 'main' = the main branch (null). */
async function check(businessId, value, trx = knex, field = 'branch_id') {
  if (value === undefined || value === null || value === '' || value === 'main') return null;
  const id = Number(value);
  const row = Number.isInteger(id) && id > 0 ? await trx('clinic_branches').where({ id, business_id: businessId, is_active: true }).first('id') : null;
  if (!row) throw E.validation({ [field]: 'Choose a valid branch.' });
  return row.id;
}

/** The branch a doctor works in (null = main). */
async function ofDoctor(businessId, doctorId, trx = knex) {
  if (!doctorId) return null;
  const d = await trx('doctors').where({ id: doctorId, business_id: businessId }).first('branch_id');
  return d ? d.branch_id || null : null;
}

/** Refuses one more active branch beyond the package (the main branch counts as one). */
async function ensureRoom(business) {
  const allowed = await require('../subscriptions/subscriptions.service').branchAllowance(business); // eslint-disable-line global-require
  if (allowed === null) return;
  const active = (await list(business.id, { activeOnly: true })).length + 1;
  if (active + 1 > allowed) {
    throw new AppError('PLAN_LIMIT_BRANCHES', 'Your package does not include another branch.', 402, { limit: allowed, used: active });
  }
}

async function get(ctx, id) {
  const row = await knex('clinic_branches').where({ id, business_id: ctx.businessId }).first();
  if (!row) throw E.notFound('Branch');
  return row;
}

async function save(ctx, business, id, input) {
  const d = validate(schema, input || {});
  const row = { ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v])), updated_at: new Date() };
  if (id) {
    const before = await get(ctx, id);
    await knex('clinic_branches').where({ id: before.id, business_id: ctx.businessId }).update(row);
    const { oldValues, newValues, changed } = audit.diff(before, row);
    delete oldValues.updated_at; delete newValues.updated_at;
    if (changed) await audit.record(ctx, 'branch.updated', { entityType: 'branch', entityId: before.id, oldValues, newValues });
    forget(ctx.businessId);
    return before.id;
  }
  await ensureRoom(business);
  const [newId] = await knex('clinic_branches').insert({ ...row, business_id: ctx.businessId, is_active: true });
  await audit.record(ctx, 'branch.created', { entityType: 'branch', entityId: newId, newValues: d });
  forget(ctx.businessId);
  return newId;
}

/** What still depends on a branch: active doctors, upcoming appointments, any appointment at all. */
async function usage(businessId, id, today) {
  const count = async (q) => Number((await q.count({ n: '*' }))[0].n);
  const [doctors, upcoming, appointments] = await Promise.all([
    count(knex('doctors').where({ business_id: businessId, branch_id: id, is_active: true })),
    count(knex('appointments').where({ business_id: businessId, branch_id: id }).where('appointment_date', '>=', today).whereNotIn('status', ['cancelled', 'completed', 'no_show'])),
    count(knex('appointments').where({ business_id: businessId, branch_id: id })),
  ]);
  return { doctors, upcoming, appointments };
}

/** Turns a branch on (within the package) or off (only once no active doctor works there and nothing is booked). */
async function setActive(ctx, business, id, on) {
  const b = await get(ctx, id);
  if (Boolean(b.is_active) === on) return;
  if (on) await ensureRoom(business);
  else {
    const u = await usage(ctx.businessId, b.id, ctx.today || new Date().toISOString().slice(0, 10));
    if (u.doctors) throw new AppError('BRANCH_HAS_DOCTORS', 'Move this branch’s doctors to another branch first.', 409);
    if (u.upcoming) throw new AppError('BRANCH_HAS_APPOINTMENTS', 'This branch has upcoming appointments. Move or cancel them first.', 409);
  }
  await knex('clinic_branches').where({ id: b.id, business_id: ctx.businessId }).update({ is_active: on, updated_at: new Date() });
  await audit.record(ctx, on ? 'branch.activated' : 'branch.deactivated', { entityType: 'branch', entityId: b.id, oldValues: { is_active: Boolean(b.is_active) }, newValues: { is_active: on, name: b.name } });
  forget(ctx.businessId);
}

/** Deletes a branch nothing ever used (no doctor, no appointment); otherwise it can only be turned off. */
async function remove(ctx, id) {
  const b = await get(ctx, id);
  const [{ n }] = await knex('doctors').where({ business_id: ctx.businessId, branch_id: b.id }).count({ n: '*' });
  const u = await usage(ctx.businessId, b.id, '0000-01-01');
  if (Number(n) || u.appointments) throw new AppError('BRANCH_IN_USE', 'This branch has doctors or appointments. Turn it off instead.', 409);
  await knex('clinic_branches').where({ id: b.id, business_id: ctx.businessId }).del();
  await audit.record(ctx, 'branch.deleted', { entityType: 'branch', entityId: b.id, oldValues: { name: b.name, address: b.address } });
  forget(ctx.businessId);
}

/** The main branch's short name (the top bar shows it instead of the clinic's long name). */
async function setMainShort(ctx, value) {
  const v = String(value || '').trim().slice(0, 40) || null;
  const before = await knex('businesses').where({ id: ctx.businessId }).first('branch_short');
  await knex('businesses').where({ id: ctx.businessId }).update({ branch_short: v });
  await audit.record(ctx, 'branch.main_short', { entityType: 'business', entityId: ctx.businessId, oldValues: { branch_short: before ? before.branch_short : null }, newValues: { branch_short: v } });
  require('../businesses/business.service').forget(ctx.businessId); // eslint-disable-line global-require
}
/** '' (every branch), 'main' or a branch id of this clinic → that value; anything else → null (refused). */
async function validScope(businessId, v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (s === '' || s === 'main') return s;
  return /^\d+$/.test(s) && (await knex('clinic_branches').where({ business_id: businessId, id: Number(s) }).first('id')) ? s : null;
}

// ---------------------------------------------------------------- patients of a branch (patient_branches)
const keyOf = (branchId) => (branchId ? String(branchId) : 'main');
/** A patient seen in a branch (booked there, added there): kept once. */
async function attachPatient(db, businessId, patientId, branchId) {
  if (!patientId || !(await multi(businessId).catch(() => false))) return;
  await db('patient_branches').insert({ business_id: businessId, patient_id: patientId, branch_key: keyOf(branchId) }).onConflict(['patient_id', 'branch_key']).ignore();
}
/** Patients of the branch the member works in: theirs, and those not given a branch yet. */
function scopePatients(q, ctx, col = 'patients.id') {
  const v = ctx && ctx.workBranch;
  if (!v) return q;
  return q.where((w) => w
    .whereExists(function mine() { this.select(knex.raw('1')).from('patient_branches as pb').whereRaw('pb.patient_id = ??', [col]).where('pb.branch_key', String(v)); })
    .orWhereNotExists(function none() { this.select(knex.raw('1')).from('patient_branches as pb2').whereRaw('pb2.patient_id = ??', [col]); }));
}
const patientBranches = (businessId, patientId) => knex('patient_branches').where({ business_id: businessId, patient_id: patientId }).pluck('branch_key');
/** The patient's branches as chosen on their file (at least one); audited. */
async function setPatientBranches(ctx, patientId, keys) {
  const valid = new Set(['main', ...(await list(ctx.businessId)).map((r) => String(r.id))]);
  const want = [...new Set([].concat(keys || []).map(String))].filter((k) => valid.has(k));
  if (!want.length) throw E.validation({ branches: 'Choose at least one branch.' });
  const before = await patientBranches(ctx.businessId, patientId);
  await knex.transaction(async (trx) => {
    await trx('patient_branches').where({ business_id: ctx.businessId, patient_id: patientId }).whereNotIn('branch_key', want).del();
    for (const k of want) await trx('patient_branches').insert({ business_id: ctx.businessId, patient_id: patientId, branch_key: k }).onConflict(['patient_id', 'branch_key']).ignore(); // eslint-disable-line no-await-in-loop, no-restricted-syntax
  });
  await audit.record(ctx, 'patient.branches', { entityType: 'patient', entityId: patientId, oldValues: { branches: before }, newValues: { branches: want } });
  return want;
}

/** The branch's visits (a subquery of appointment ids). */
const visitIds = (ctx) => { const v = String(ctx.workBranch); return knex('appointments').select('id').where('business_id', ctx.businessId).modify((x) => (v === 'main' ? x.whereNull('branch_id') : x.where('branch_id', Number(v)))); };
/** Receipts / papers of the branch: by their visit's branch (one without a visit belongs to the main branch). */
function scopeByVisit(q, ctx, col = 'i.appointment_id') {
  const v = ctx && ctx.workBranch;
  if (!v) return q;
  return String(v) === 'main' ? q.where((w) => w.whereNull(col).orWhereIn(col, visitIds(ctx))) : q.whereIn(col, visitIds(ctx));
}
/** The branch's doctors (a subquery of doctor ids). */
const doctorIds = (ctx) => scope(knex('doctors').select('id').where('business_id', ctx.businessId), ctx, 'branch_id');

/** Staff of the branch: members tied to it (Team → branch), and doctors' logins whose doctor works there. */
function scopeMembers(q, ctx, m = 'm') {
  const v = ctx && ctx.workBranch;
  if (!v) return q;
  return q.where((w) => w.where(`${m}.work_branch`, String(v)).orWhere((x) => x.where(`${m}.work_branch`, '').whereIn(`${m}.doctor_id`, doctorIds(ctx))));
}

/** A query narrowed to the branch the member works in (account menu): 'main' = no branch, an id = that branch. */
function scope(q, ctx, col = 'a.branch_id') {
  const v = ctx && ctx.workBranch;
  if (v === 'main') q.whereNull(col);
  else if (Number(v)) q.where(col, Number(v));
  return q;
}

module.exports = { scope, scopeMembers, scopeByVisit, doctorIds, keyOf, attachPatient, scopePatients, patientBranches, setPatientBranches, setMainShort, validScope, list, multi, nameOf, options, labelOf, check, ofDoctor, ensureRoom, get, save, usage, setActive, remove, forget };
