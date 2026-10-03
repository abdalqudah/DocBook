// "This other clinic of mine is really a branch": a clinic made with "Add a clinic" (a separate clinic: its own
// patients, team and settings) becomes a branch of the signed-in clinic. The branch takes its name, address and
// phones; its doctors are copied into that branch (a doctor with the same name already here is not duplicated).
// The other clinic can then be deleted, but only while it holds no patients, appointments or invoices — clinical and
// money records are never moved between clinics or lost. Only an owner of BOTH clinics may do this (checked here from
// the memberships, never from the form), and it is audited in both.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const branches = require('./branches.service');

const count = async (table, businessId) => Number((await knex(table).where({ business_id: businessId }).count({ n: '*' }))[0].n);

/** The signed-in user's other clinics where they are the owner, each with what it holds. */
async function candidates(ctx) {
  const rows = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').join('businesses as b', 'b.id', 'm.business_id')
    .where({ 'm.user_id': ctx.userId, 'r.key': 'owner' }).whereNot('b.id', ctx.businessId)
    .select('b.id', 'b.name', 'b.name_en', 'b.city', 'b.address', 'b.phone', 'b.whatsapp').orderBy('b.name');
  const out = [];
  for (const b of rows) { // eslint-disable-line no-restricted-syntax
    const [patients, appointments, invoices, doctors] = await Promise.all(['patients', 'appointments', 'invoices', 'doctors'].map((t) => count(t, b.id))); // eslint-disable-line no-await-in-loop
    out.push({ ...b, patients, appointments, invoices, doctors, empty: !patients && !appointments && !invoices });
  }
  return out;
}

async function ownerOf(userId, businessId) {
  return knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.user_id': userId, 'm.business_id': businessId, 'r.key': 'owner' }).first('m.id');
}

/**
 * Makes clinic `otherId` a branch of the signed-in clinic. { remove: true } also deletes the other clinic (only when
 * empty). Returns { branchId, doctors, removed }.
 */
async function absorb(ctx, business, otherId, { remove = false } = {}) {
  const id = Number(otherId) || 0;
  if (!id || id === ctx.businessId) throw E.notFound('Clinic');
  if (!(await ownerOf(ctx.userId, ctx.businessId)) || !(await ownerOf(ctx.userId, id))) throw E.forbidden('clinic.owner');
  const other = (await candidates(ctx)).find((c) => c.id === id);
  if (!other) throw E.notFound('Clinic');
  if (remove && !other.empty) throw new AppError('CLINIC_NOT_EMPTY', 'This clinic has patients, appointments or invoices.', 409);
  const clean = (v) => (v && /^[+0-9\s()-]{6,40}$/.test(String(v).trim()) ? String(v).trim() : '');
  const branchId = await branches.save(ctx, business, null, {
    name: other.name, name_en: other.name_en || '', city: other.city || '', address: other.address || '', phone: clean(other.phone), whatsapp: clean(other.whatsapp),
  });
  // Doctors: copied into the new branch, without the per-clinic links (login, rules, website pages).
  const here = new Set((await knex('doctors').where({ business_id: ctx.businessId }).select('full_name')).map((d) => String(d.full_name).trim()));
  const theirs = await knex('doctors').where({ business_id: id });
  const skip = new Set(['id', 'business_id', 'branch_id', 'created_at', 'updated_at']);
  let copied = 0;
  for (const d of theirs) { // eslint-disable-line no-restricted-syntax
    if (here.has(String(d.full_name).trim())) continue; // eslint-disable-line no-continue
    const row = Object.fromEntries(Object.entries(d).filter(([k]) => !skip.has(k)));
    await knex('doctors').insert({ ...row, business_id: ctx.businessId, branch_id: branchId }); // eslint-disable-line no-await-in-loop
    copied += 1;
  }
  await audit.record(ctx, 'branch.from_clinic', { entityType: 'branch', entityId: branchId, newValues: { clinic_id: id, name: other.name, doctors: copied, removed: Boolean(remove) } });
  let removed = false;
  if (remove) {
    const businesses = require('../businesses/business.service'); // eslint-disable-line global-require
    await businesses.destroy({ ...ctx, businessId: id }, (await knex('businesses').where({ id }).first('name')).name);
    removed = true;
  } else {
    await audit.record({ ...ctx, businessId: id }, 'clinic.made_branch', { entityType: 'clinic', entityId: id, newValues: { into_clinic: ctx.businessId, branch_id: branchId } });
  }
  return { branchId, doctors: copied, removed };
}

module.exports = { candidates, absorb };
