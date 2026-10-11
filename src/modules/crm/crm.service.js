// The platform owner's CRM (Admin → CRM): everyone the platform deals with — clinics, drug warehouses, reps,
// prospects and partners — with their stage, the next follow-up, and a timeline of notes, calls, e-mails and WhatsApp
// messages. Clinics and warehouses that sign up are added by themselves (sync); prospects are added by hand.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');

const KINDS = ['clinic', 'warehouse', 'rep', 'prospect', 'partner', 'other'];
const STAGES = ['new', 'contacted', 'interested', 'demo', 'trial', 'customer', 'lost'];
const SOURCES = ['signup', 'website', 'whatsapp', 'call', 'referral', 'event', 'import', 'other'];
const ACT_KINDS = ['note', 'call', 'email', 'whatsapp', 'meeting', 'stage'];

const str = (v, n) => { const s = String(v === undefined || v === null ? '' : v).trim().slice(0, n); return s || null; };
const like = (q) => `%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Adds the clinics and warehouses not in the CRM yet (source "signup") → how many were added. */
async function sync() {
  let added = 0;
  const clinics = await knex('businesses as b').where('b.kind', '!=', 'center_admin')
    .whereNotExists(function e() { this.select(knex.raw('1')).from('crm_contacts as c').whereRaw('c.business_id = b.id'); })
    .select('b.id', 'b.name', 'b.phone', 'b.whatsapp', 'b.email', 'b.country', 'b.city', 'b.status', 'b.created_at').limit(2000);
  for (const b of clinics) { // eslint-disable-line no-restricted-syntax
    const owner = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').join('users as u', 'u.id', 'm.user_id') // eslint-disable-line no-await-in-loop
      .where({ 'm.business_id': b.id, 'r.key': 'owner' }).orderBy('m.id').first('u.name', 'u.email', 'u.phone').catch(() => null);
    await knex('crm_contacts').insert({ // eslint-disable-line no-await-in-loop
      kind: 'clinic', name: (owner && owner.name) || b.name, organization: b.name, phone: b.phone || (owner && owner.phone) || null, whatsapp: b.whatsapp || null,
      email: (owner && owner.email) || b.email || null, country: b.country || null, city: b.city || null, stage: b.status === 'active' ? 'customer' : 'new', source: 'signup', business_id: b.id,
    });
    added += 1;
  }
  const vendors = await knex('vendors as v').whereNotExists(function e() { this.select(knex.raw('1')).from('crm_contacts as c').whereRaw('c.vendor_id = v.id'); })
    .select('v.id', 'v.type', 'v.name', 'v.contact_name', 'v.phone', 'v.whatsapp', 'v.email', 'v.country', 'v.city', 'v.status').limit(2000);
  for (const v of vendors) { // eslint-disable-line no-restricted-syntax
    await knex('crm_contacts').insert({ // eslint-disable-line no-await-in-loop
      kind: v.type === 'rep' ? 'rep' : v.type === 'warehouse' ? 'warehouse' : 'partner', name: v.contact_name || v.name, organization: v.name, phone: v.phone || null, whatsapp: v.whatsapp || null,
      email: v.email || null, country: v.country || null, city: v.city || null, stage: v.status === 'active' ? 'customer' : 'new', source: 'signup', vendor_id: v.id,
    });
    added += 1;
  }
  return added;
}

/** filters: q, kind, stage, country, due ('1' = follow-up due by today). */
async function list(f = {}, { now = new Date() } = {}) {
  const q = knex('crm_contacts as c').select('c.*').orderByRaw('c.next_action_at IS NULL, c.next_action_at').orderBy('c.updated_at', 'desc').limit(500);
  if (KINDS.includes(f.kind)) q.where('c.kind', f.kind);
  if (STAGES.includes(f.stage)) q.where('c.stage', f.stage);
  if (/^[A-Z]{2}$/.test(String(f.country || ''))) q.where('c.country', f.country);
  if (f.due === '1') q.whereNotNull('c.next_action_at').where('c.next_action_at', '<=', endOfDay(now));
  if (f.q && String(f.q).trim()) { const s = like(f.q); q.andWhere((w) => w.where('c.name', 'like', s).orWhere('c.organization', 'like', s).orWhere('c.email', 'like', s).orWhere('c.phone', 'like', s).orWhere('c.whatsapp', 'like', s).orWhere('c.city', 'like', s)); }
  return q;
}
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

/** Counts for the pipeline bar, the "due" badge and the country filter. */
async function summary(now = new Date()) {
  const [stages, [{ due }], countries] = await Promise.all([
    knex('crm_contacts').groupBy('stage').select('stage').count({ n: '*' }),
    knex('crm_contacts').whereNotNull('next_action_at').where('next_action_at', '<=', endOfDay(now)).count({ due: '*' }),
    knex('crm_contacts').whereNotNull('country').groupBy('country').select('country').count({ n: '*' }).orderBy('n', 'desc'),
  ]);
  const by = Object.fromEntries(stages.map((r) => [r.stage, Number(r.n)]));
  return { stages: STAGES.map((k) => ({ key: k, n: by[k] || 0 })), due: Number(due), countries: countries.map((r) => ({ code: r.country, n: Number(r.n) })) };
}

async function get(id) {
  const c = await knex('crm_contacts').where({ id: Number(id) || 0 }).first();
  if (!c) throw E.notFound('Contact');
  c.activities = await knex('crm_activities as a').leftJoin('users as u', 'u.id', 'a.user_id').where('a.contact_id', c.id)
    .orderBy('a.created_at', 'desc').orderBy('a.id', 'desc').limit(200).select('a.*', 'u.name as by_name');
  return c;
}

function clean(input) {
  const errors = {};
  const row = {
    kind: KINDS.includes(input.kind) ? input.kind : 'prospect', name: str(input.name, 190), organization: str(input.organization, 190),
    phone: str(input.phone, 40), whatsapp: str(input.whatsapp, 40), email: str(input.email, 190), country: /^[A-Za-z]{2}$/.test(String(input.country || '')) ? String(input.country).toUpperCase() : null,
    city: str(input.city, 120), stage: STAGES.includes(input.stage) ? input.stage : 'new', source: SOURCES.includes(input.source) ? input.source : null,
    next_action: str(input.next_action, 255), next_action_at: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(input.next_action_at || '')) ? new Date(String(input.next_action_at).length === 10 ? `${input.next_action_at}T09:00` : input.next_action_at) : null,
    notes: str(input.notes, 5000),
  };
  if (!row.name) errors.name = 'Required.';
  if (row.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(row.email)) errors.email = 'Enter a valid email address.';
  if (Object.keys(errors).length) throw E.validation(errors);
  return row;
}

async function save(ctx, id, input) {
  const row = clean(input);
  if (id) {
    const before = await knex('crm_contacts').where({ id }).first();
    if (!before) throw E.notFound('Contact');
    await knex('crm_contacts').where({ id }).update({ ...row, updated_at: new Date() });
    if (before.stage !== row.stage) await log(ctx, id, 'stage', `${before.stage} → ${row.stage}`);
    await audit.record(ctx, 'crm.contact_updated', { entityType: 'crm_contact', entityId: id, newValues: { stage: row.stage, name: row.name } });
    return id;
  }
  const [nid] = await knex('crm_contacts').insert({ ...row, created_by: ctx.userId || null });
  await audit.record(ctx, 'crm.contact_created', { entityType: 'crm_contact', entityId: nid, newValues: { name: row.name, kind: row.kind } });
  return nid;
}

async function remove(ctx, id) {
  const c = await knex('crm_contacts').where({ id }).first('id', 'name');
  if (!c) throw E.notFound('Contact');
  await knex('crm_contacts').where({ id }).del();
  await audit.record(ctx, 'crm.contact_deleted', { entityType: 'crm_contact', entityId: id, oldValues: { name: c.name } });
}

/** A timeline entry (note, call, meeting…; e-mails and WhatsApp messages with their status). Touches the contact. */
async function log(ctx, contactId, kind, body, status = null) {
  if (!ACT_KINDS.includes(kind)) throw E.validation({ kind: 'Choose a valid value.' });
  const text = str(body, 8000);
  if (!text && kind !== 'stage') throw E.validation({ body: 'Required.' });
  const [id] = await knex('crm_activities').insert({ contact_id: contactId, kind, body: text, status, user_id: ctx.userId || null });
  await knex('crm_contacts').where({ id: contactId }).update({ updated_at: new Date() });
  return id;
}

/** Sets (or clears) the next follow-up. */
async function followUp(ctx, id, { at, text }) {
  const when = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(at || '')) ? new Date(String(at).length === 10 ? `${at}T09:00` : at) : null;
  await knex('crm_contacts').where({ id }).update({ next_action_at: when, next_action: str(text, 255), updated_at: new Date() });
}

/** E-mails a contact from the platform's address and logs it. */
async function email(ctx, id, { subject, body }, locale = 'ar') {
  const c = await get(id);
  if (!c.email) throw E.validation({ subject: 'This contact has no email address.' });
  const subj = str(subject, 200); const text = str(body, 8000);
  if (!subj || !text) throw E.validation({ subject: !subj ? 'Required.' : undefined, body: !text ? 'Required.' : undefined });
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  if (!(await mailer.configuredFor(null))) throw E.validation({ subject: 'Set up the platform e-mail first (Admin → Platform settings).' });
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  let ok = true;
  try { ok = await mailer.send({ to: c.email, subject: subj, html: mailer.layout({ locale, title: subj, body: esc(text).replace(/\n/g, '<br>') }) }); } catch { ok = false; }
  await log(ctx, c.id, 'email', `${subj}\n\n${text}`, ok ? 'sent' : 'failed');
  if (!ok) throw E.validation({ subject: 'The e-mail could not be sent. Check the platform e-mail settings.' });
}

/** Sends a WhatsApp message through the platform's number (Cloud API) and logs it → { ok, error }. */
async function whatsapp(ctx, id, text) {
  const c = await get(id);
  const to = c.whatsapp || c.phone;
  const body = str(text, 4000);
  if (!to) throw E.validation({ wa_text: 'This contact has no WhatsApp or phone number.' });
  if (!body) throw E.validation({ wa_text: 'Required.' });
  const r = await require('../platformcomms/comms.service').sendWhatsAppText(to, body); // eslint-disable-line global-require
  await log(ctx, c.id, 'whatsapp', body, r.ok ? 'sent' : 'failed');
  return r;
}

module.exports = { KINDS, STAGES, SOURCES, ACT_KINDS, sync, list, summary, get, save, remove, log, followUp, email, whatsapp };
