// Pharmacies, imaging centres and laboratories the clinic works with — outside, or inside the clinic itself.
//   list / get / save / remove           the clinic's list (Settings → Pharmacies & centres)
//   forDoc(ctx, docKind, docId)          which partners fit a paper: prescription → pharmacies, lab request → labs,
//                                        imaging request → imaging centres
//   record(ctx, partner, doc, channel)   a paper sent (WhatsApp / e-mail / to the centre inside the clinic)
//   queue(ctx, partnerId)                what was sent to a centre inside the clinic, open requests first
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { z, validate, optionalString, email, emptyToUndefined } = require('../../core/validate');
const { E } = require('../../core/errors');

const KINDS = ['pharmacy', 'imaging', 'lab', 'hospital'];
/** An http(s) address (a map link, a website); "www.x.com" gets https:// in front. */
const webUrl = (max) => z.string().trim().max(max).transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
  .refine((v) => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) && u.hostname.includes('.'); } catch { return false; } }, 'Enter a valid web address.');
const schema = z.object({
  kind: z.enum(KINDS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  name: z.string().trim().min(1, 'Required.').max(120),
  phone: optionalString(40), email: z.preprocess(emptyToUndefined, email().optional()), address: optionalString(255), notes: optionalString(500),
  contact_name: optionalString(120), phone2: optionalString(40), city: optionalString(100), hours: optionalString(255),
  map_url: z.preprocess(emptyToUndefined, webUrl(500).optional()), website: z.preprocess(emptyToUndefined, webUrl(255).optional()),
});
const on = (raw) => { const v = Array.isArray(raw) ? raw[raw.length - 1] : raw; return v === '1' || v === true || v === 'on'; };

const forget = (businessId) => cache.forgetPrefix(`partners:${businessId}`);
const list = (businessId, { activeOnly = false } = {}) => cache.remember(`partners:${businessId}:${activeOnly ? 'a' : 'all'}`,
  () => knex('clinic_partners').where({ business_id: businessId }).modify((q) => { if (activeOnly) q.where({ is_active: true }); }).orderBy([{ column: 'kind' }, { column: 'in_house', order: 'desc' }, { column: 'name' }]), 60_000);

async function get(ctx, id) {
  const p = await knex('clinic_partners').where({ id: Number(id) || 0, business_id: ctx.businessId }).first();
  if (!p) throw E.notFound('Partner');
  return p;
}

async function save(ctx, id, input) {
  const d = validate(schema, input);
  const row = { kind: d.kind, name: d.name, phone: d.phone || null, email: d.email || null, address: d.address || null, notes: d.notes || null,
    contact_name: d.contact_name || null, phone2: d.phone2 || null, city: d.city || null, map_url: d.map_url || null, hours: d.hours || null, website: d.website || null, in_house: on(input.in_house), is_active: id ? on(input.is_active) : true };
  if (!row.in_house && !row.phone && !row.email) throw E.validation({ phone: 'Add a WhatsApp number or an e-mail address.' });
  let pid = id;
  if (id) {
    const before = await get(ctx, id);
    await knex('clinic_partners').where({ id: before.id }).update({ ...row, updated_at: new Date() });
    await audit.record(ctx, 'partner.updated', { entityType: 'clinic_partner', entityId: before.id, oldValues: { name: before.name, kind: before.kind }, newValues: row });
  } else {
    [pid] = await knex('clinic_partners').insert({ business_id: ctx.businessId, ...row });
    await audit.record(ctx, 'partner.created', { entityType: 'clinic_partner', entityId: pid, newValues: row });
  }
  forget(ctx.businessId);
  return pid;
}

async function remove(ctx, id) {
  const p = await get(ctx, id);
  await knex('clinic_partners').where({ id: p.id }).del();
  await knex('medical_orders').where({ business_id: ctx.businessId, partner_id: p.id }).update({ partner_id: null });
  await audit.record(ctx, 'partner.deleted', { entityType: 'clinic_partner', entityId: p.id, oldValues: { name: p.name, kind: p.kind } });
  forget(ctx.businessId);
}

/** The paper a partner gets: its kind (prescription / order), patient, visit, and the partner kind it fits. */
async function docOf(ctx, docKind, docId) {
  const id = Number(docId) || 0;
  if (docKind === 'prescription') {
    const r = await knex('prescriptions').where({ business_id: ctx.businessId, id }).first('id', 'appointment_id', 'patient_name', 'doctor_id');
    if (!r || (ctx.ownDoctorId && r.doctor_id && r.doctor_id !== ctx.ownDoctorId)) throw E.notFound('Prescription');
    return { ...r, partnerKind: 'pharmacy' };
  }
  if (docKind === 'order') {
    const o = await knex('medical_orders').where({ business_id: ctx.businessId, id }).first('id', 'appointment_id', 'patient_name', 'doctor_id', 'kind', 'status', 'partner_id');
    if (!o || (ctx.ownDoctorId && o.doctor_id && o.doctor_id !== ctx.ownDoctorId)) throw E.notFound('Order');
    return { ...o, partnerKind: o.kind === 'imaging' ? 'imaging' : 'lab' };
  }
  throw E.notFound('Document');
}

/** Active partners that fit a paper, with what was already sent to whom. */
async function forDoc(ctx, docKind, docId) {
  const doc = await docOf(ctx, docKind, docId);
  const [all, sent] = await Promise.all([
    list(ctx.businessId, { activeOnly: true }),
    knex('partner_sends as s').join('clinic_partners as p', 'p.id', 's.partner_id').where({ 's.business_id': ctx.businessId, 's.doc_kind': docKind, 's.doc_id': doc.id })
      .orderBy('s.id', 'desc').select('s.partner_id', 's.channel', 's.created_at', 'p.name'),
  ]);
  return { doc, partners: all.filter((p) => p.kind === doc.partnerKind), sent };
}

async function record(ctx, partner, doc, docKind, channel, shareLinkId = null) {
  const [id] = await knex('partner_sends').insert({
    business_id: ctx.businessId, partner_id: partner.id, doc_kind: docKind, doc_id: doc.id, appointment_id: doc.appointment_id || null,
    patient_name: doc.patient_name || null, channel, share_link_id: shareLinkId, sent_by: ctx.userId || null,
  });
  if (docKind === 'order') await knex('medical_orders').where({ business_id: ctx.businessId, id: doc.id }).update({ partner_id: partner.id, updated_at: new Date() });
  await audit.record(ctx, 'partner.paper_sent', { entityType: docKind, entityId: doc.id, newValues: { partner: partner.name, partner_id: partner.id, channel } });
  return id;
}

/** A centre inside the clinic: the papers sent to it (requests with their status), open ones first. */
async function queue(ctx, partnerId) {
  const p = await get(ctx, partnerId);
  const rows = await knex('partner_sends as s')
    .leftJoin('medical_orders as o', function j() { this.on('o.id', 's.doc_id').andOn('o.business_id', 's.business_id').andOnVal('s.doc_kind', '=', 'order'); })
    .where({ 's.business_id': ctx.businessId, 's.partner_id': p.id })
    
    // a doctor login: papers of their own visits (or their own orders); the branch: by the visit's branch
    .modify((q) => {
      if (ctx.ownDoctorId) q.where((w) => w.where('o.doctor_id', ctx.ownDoctorId).orWhereIn('s.appointment_id', knex('appointments').select('id').where({ business_id: ctx.businessId, doctor_id: ctx.ownDoctorId })));
      require('../clinic/branches.service').scopeByVisit(q, ctx, 's.appointment_id'); // eslint-disable-line global-require
    })
    .orderBy('s.id', 'desc').limit(300)
    .select('s.id', 's.doc_kind', 's.doc_id', 's.appointment_id', 's.patient_name', 's.channel', 's.created_at', 's.status as send_status', 'o.status as order_status', 'o.items', 'o.urgency', 'o.kind as order_kind');
  // One line per paper (the latest send), open requests first.
  const seen = new Set();
  const items = rows.filter((r) => { const k = `${r.doc_kind}:${r.doc_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const open = (r) => (r.doc_kind === 'order' ? r.order_status === 'ordered' : r.send_status !== 'done');
  items.sort((a, b) => Number(open(b)) - Number(open(a)));
  return { partner: p, items: items.map((r) => ({ ...r, open: open(r), items: typeof r.items === 'string' ? JSON.parse(r.items || '[]') : (r.items || []) })) };
}

/** A prescription handed over at the pharmacy inside the clinic. */
async function markDone(ctx, sendId) {
  const s = await knex('partner_sends').where({ business_id: ctx.businessId, id: Number(sendId) || 0 }).first();
  if (!s) throw E.notFound('Send');
  await knex('partner_sends').where({ business_id: ctx.businessId, partner_id: s.partner_id, doc_kind: s.doc_kind, doc_id: s.doc_id }).update({ status: 'done' });
  await audit.record(ctx, 'partner.paper_done', { entityType: s.doc_kind, entityId: s.doc_id, newValues: { partner_id: s.partner_id } });
  return s;
}

module.exports = { KINDS, list, get, save, remove, docOf, forDoc, record, queue, markDone, forget };
