// University partner portal: partnership requests from the website, partner accounts (university staff), and the
// content they submit (programs, scholarships, the university profile). Nothing a partner writes reaches the
// public site until a GEC reviewer approves it; the reviewer sees exactly what changes.
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const { z, validate } = require('../../core/validate');
const { slugify } = require('../../core/resource');
const people = require('../crm/people');
const ref = require('../catalog/reference');
const money = require('../catalog/money');
const events = require('../../core/events');

// ------------------------------------------------------------------ field whitelists (what partners may edit)
const opt = (s) => z.preprocess((v) => (v === '' || v === undefined || v === null ? undefined : v), s.optional());
const text = (n) => opt(z.string().trim().max(n));
const num = (min, max) => opt(z.coerce.number().min(min).max(max));
const int = (min, max) => opt(z.coerce.number().int().min(min).max(max));
const bool = () => z.preprocess((v) => (v === undefined ? undefined : [].concat(v).includes('1') || v === true || v === 'on'), z.boolean().optional());
const url = () => opt(z.string().trim().max(500).regex(/^https:\/\//, 'Use a full https:// address.'));
const date = () => opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.'));
const list = (max) => z.preprocess((v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean).slice(0, max), z.array(z.string().max(200)));
const months = () => z.preprocess((v) => [].concat(v || []).map(Number).filter((m) => m >= 1 && m <= 12), z.array(z.number().int()));
const currency = () => opt(z.string().regex(/^[A-Z]{3}$/));

const SCHEMAS = {
  program: z.object({
    name_en: z.string().trim().min(3, 'Enter the program name.').max(190), name_ar: text(190),
    degree_level: z.enum(ref.DEGREES), field: z.enum(ref.FIELDS), faculty: text(160), duration_months: int(1, 120),
    study_mode: z.enum(ref.STUDY_MODES).default('on_campus'), program_url: url(),
    description_en: text(8000), description_ar: text(8000), currency: currency(), tuition_fee: int(0, 1000000), application_fee: int(0, 100000),
    scholarships_available: bool(), intakes: months(), next_deadline: date(), deadline_note: text(190), min_gpa_pct: num(0, 100),
    academic_en: text(4000), academic_ar: text(4000), min_ielts: num(0, 9), min_toefl: int(0, 120), min_pte: int(0, 90), min_duolingo: int(0, 160),
    documents_required: list(20), internship: z.enum(['none', 'optional', 'included', 'coop']).default('none'), work_after_study: bool(), work_after_study_note: text(255),
    is_active: bool(),
  }),
  scholarship: z.object({
    name_en: z.string().trim().min(3, 'Enter the scholarship name.').max(190), name_ar: text(190), provider_en: text(190), provider_ar: text(190),
    amount_type: z.enum(['fixed', 'percentage', 'full', 'varies']).default('fixed'), amount_min: int(0, 1000000), amount_max: int(0, 1000000), currency: currency(),
    coverage_en: text(255), coverage_ar: text(255), description_en: text(8000), description_ar: text(8000), eligibility_en: list(30), eligibility_ar: list(30),
    degree_levels: z.preprocess((v) => [].concat(v || []).filter((d) => ref.DEGREES.includes(d)), z.array(z.string())), min_gpa_pct: num(0, 100), min_ielts: num(0, 9),
    deadline: date(), deadline_note: text(190), source_url: url(), is_active: bool(),
  }),
  university: z.object({
    name_ar: text(190), website: url(), logo: opt(z.string().trim().max(500).regex(/^(https:\/\/|\/media\/\d+$)/)), cover_image: opt(z.string().trim().max(500).regex(/^(https:\/\/|\/media\/\d+$)/)),
    description_en: text(8000), description_ar: text(8000), campus_en: text(4000), campus_ar: text(4000), accommodation_en: text(4000), accommodation_ar: text(4000),
    admission_en: text(4000), admission_ar: text(4000), deadlines_en: text(2000), deadlines_ar: text(2000), contact_email: opt(z.string().trim().email().max(190)), contact_phone: text(40),
    intakes: months(), application_fee: int(0, 100000), tuition_min: int(0, 1000000), tuition_max: int(0, 1000000), min_ielts: num(0, 9), min_toefl: int(0, 120),
  }),
};
const TABLE = { program: 'programs', scholarship: 'scholarships', university: 'universities' };
const JSON_FIELDS = ['intakes', 'documents_required', 'degree_levels', 'eligibility_en', 'eligibility_ar'];

/** Validated data holding only the fields the form sent; a field sent empty becomes null (cleared), one not sent stays untouched. */
function parse(entity, body) {
  const data = validate(SCHEMAS[entity], body);
  const out = {};
  for (const k of Object.keys(SCHEMAS[entity].shape)) {
    if (data[k] !== undefined) out[k] = data[k];
    else if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = null;
  }
  return out;
}

/** The partner's university for a signed-in partner user (null if none). */
async function membership(userId) {
  return knex('partner_members as m').join('universities as u', 'u.id', 'm.university_id').where('m.user_id', userId)
    .first('m.*', 'u.slug', 'u.name_en', 'u.name_ar', 'u.logo', 'u.country_code', 'u.currency as uni_currency');
}

// ------------------------------------------------------------------ partnership requests (public form)
async function apply(ctx, d) {
  const recent = await knex('partner_applications').where({ email: d.email }).where('created_at', '>', new Date(Date.now() - 86400_000)).first('id');
  if (recent) return recent.id; // one request per address per day
  const [id] = await knex('partner_applications').insert({ ref: await people.newRef('partner_applications', 'PA'), ...d });
  await audit.record(ctx, 'partner.applied', { entityType: 'partner_application', entityId: id, newValues: { university: d.university_name } });
  const notify = require('../notifications/service'); // eslint-disable-line global-require
  const reviewers = await knex('users as u').join('employees as e', 'e.user_id', 'u.id').join('role_permissions as rp', 'rp.role_id', 'e.role_id').where('rp.permission', 'partners.manage').where('u.status', 'active').distinct('u.id');
  for (const r of reviewers) await notify.toUser(r.id, { category: 'partners', title: { key: 'partnerp.notify_request', vars: { name: d.university_name } }, href: `/staff/partner-requests/${id}` }); // eslint-disable-line no-await-in-loop
  return id;
}

/** Creates (or reuses) a partner account for a university and returns the set-password link. */
async function invite(ctx, { universityId, name, email, role = 'editor', jobTitle = null }) {
  const addr = String(email).trim().toLowerCase();
  let user = await knex('users').where({ kind: 'partner', email: addr }).first();
  if (user) {
    const m = await knex('partner_members').where({ user_id: user.id }).first();
    if (m && m.university_id !== universityId) throw E.validation({ email: 'This address already belongs to another university’s partner account.' });
    if (!m) await knex('partner_members').insert({ user_id: user.id, university_id: universityId, role, job_title: jobTitle });
  } else {
    const auth = require('../auth/auth.service'); // eslint-disable-line global-require
    const crypto = require('crypto'); // eslint-disable-line global-require
    const [uid] = await knex('users').insert({ kind: 'partner', email: addr, name: String(name).slice(0, 160), password_hash: await auth.hashPassword(crypto.randomBytes(24).toString('hex')), status: 'active', locale: 'en' });
    await knex('partner_members').insert({ user_id: uid, university_id: universityId, role, job_title: jobTitle });
    user = await knex('users').where({ id: uid }).first();
  }
  const r = await require('../auth/auth.service').createReset(addr, 'partner'); // eslint-disable-line global-require
  await audit.record(ctx, 'partner.invited', { entityType: 'user', entityId: user.id, newValues: { university_id: universityId, role } });
  return { user, link: r ? r.link : null };
}

/** Approves a request: links (or creates) the university, opens the partnership with GEC's rate, invites the contact. */
async function approve(ctx, id, { universityId, createUniversity, commissionType, commissionRate, currency: cur }) {
  const a = await knex('partner_applications').where({ id }).first();
  if (!a || a.status !== 'new') throw E.conflict('NOT_PENDING', 'This request was already handled.');
  let uniId = universityId;
  if (!uniId && createUniversity) {
    const base = slugify(a.university_name) || 'university';
    let slug = base; let i = 2;
    while (await knex('universities').where({ slug }).first('id')) { slug = `${base}-${i}`; i += 1; } // eslint-disable-line no-await-in-loop
    const dest = a.country_code ? await knex('destinations').where({ country_code: a.country_code }).first('id') : null;
    [uniId] = await knex('universities').insert({ slug, name_en: a.university_name, country_code: a.country_code || null, city_en: a.city || null, website: a.website || null, destination_id: dest ? dest.id : null, contact_email: a.email, is_active: false });
  }
  if (!uniId) throw E.validation({ university_id: 'Choose the university or create it.' });
  if (!(await knex('partners').where({ university_id: uniId }).whereIn('status', ['active', 'pending']).first('id'))) {
    await knex('partners').insert({ university_id: uniId, status: 'active', commission_type: commissionType || 'percent', commission_rate: Number(commissionRate) || 0, currency: cur || null, contact_name: a.contact_name, contact_email: a.email, contact_phone: a.phone });
  }
  await knex('universities').where({ id: uniId }).update({ partner_status: 'active', updated_at: new Date() });
  const inv = await invite(ctx, { universityId: uniId, name: a.contact_name, email: a.email, role: 'owner', jobTitle: a.job_title });
  await knex('partner_applications').where({ id }).update({ status: 'approved', university_id: uniId, reviewed_by: ctx.userId, reviewed_at: new Date(), updated_at: new Date() });
  await audit.record(ctx, 'partner.approved', { entityType: 'partner_application', entityId: id, newValues: { university_id: uniId } });
  return { universityId: uniId, ...inv };
}

async function reject(ctx, id, note) {
  const a = await knex('partner_applications').where({ id }).first();
  if (!a || a.status !== 'new') throw E.conflict('NOT_PENDING', 'This request was already handled.');
  await knex('partner_applications').where({ id }).update({ status: 'rejected', review_note: note ? String(note).slice(0, 500) : null, reviewed_by: ctx.userId, reviewed_at: new Date(), updated_at: new Date() });
  await audit.record(ctx, 'partner.rejected', { entityType: 'partner_application', entityId: id });
}

// ------------------------------------------------------------------ submissions
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function ownedRow(universityId, entity, entityId) {
  if (entity === 'university') return knex('universities').where({ id: universityId }).first();
  const row = await knex(TABLE[entity]).where({ id: entityId, university_id: universityId }).first();
  if (!row) throw E.notFound();
  return row;
}

/** A partner submits a new item or a change. One open submission per item: a newer one replaces it. */
async function submit(ctx, universityId, entity, entityId, body) {
  if (!SCHEMAS[entity]) throw E.notFound();
  if (entity === 'university') entityId = universityId; // eslint-disable-line no-param-reassign
  else if (entityId) await ownedRow(universityId, entity, entityId);
  const data = parse(entity, body);
  const open = await knex('partner_submissions').where({ university_id: universityId, entity, status: 'pending' }).modify((q) => (entityId ? q.where('entity_id', entityId) : q.whereNull('entity_id').whereRaw("JSON_UNQUOTE(JSON_EXTRACT(data, '$.name_en')) = ?", [data.name_en || '']))).first('id');
  let id;
  if (open) { id = open.id; await knex('partner_submissions').where({ id }).update({ data: JSON.stringify(data), submitted_by: ctx.userId, updated_at: new Date() }); } else {
    [id] = await knex('partner_submissions').insert({ university_id: universityId, entity, entity_id: entityId || null, data: JSON.stringify(data), submitted_by: ctx.userId });
  }
  await audit.record(ctx, 'partner.submitted', { entityType: 'partner_submission', entityId: id, newValues: { entity, entity_id: entityId || null } });
  await events.emit('partner.submitted', { id, universityId, entity });
  return id;
}

/** Field-by-field comparison for the reviewer: [{ field, before, after, changed }]. */
async function diff(sub) {
  const data = parseJson(sub.data);
  const current = sub.entity_id ? await knex(TABLE[sub.entity]).where({ id: sub.entity_id }).first() : null;
  const show = (v) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? '✓' : '✗') : String(v));
  return Object.keys(SCHEMAS[sub.entity].shape).filter((f) => !current || Object.prototype.hasOwnProperty.call(data, f)).map((f) => {
    let before = current ? current[f] : null;
    if (JSON_FIELDS.includes(f) && typeof before === 'string') { try { before = JSON.parse(before); } catch { /* keep text */ } }
    if (typeof before === 'number' && typeof data[f] === 'boolean') before = Boolean(before);
    const a = show(data[f]); const b = show(before);
    return { field: f, raw: data[f], before: b, after: a, changed: current ? a !== b && !(a === '' && b === '') : a !== '' };
  });
}

/** Publishes an approved submission into the catalogue. */
async function approveSubmission(ctx, id, { note } = {}) {
  const sub = await knex('partner_submissions').where({ id }).first();
  if (!sub || !['pending', 'changes_requested'].includes(sub.status)) throw E.conflict('NOT_PENDING', 'This submission was already handled.');
  const data = { ...parseJson(sub.data) };
  JSON_FIELDS.forEach((f) => { if (data[f] !== undefined) data[f] = JSON.stringify(data[f]); });
  if (sub.entity === 'program' && data.tuition_fee !== undefined) data.tuition_usd = data.tuition_fee === null ? null : await money.toUsd(data.tuition_fee, data.currency || 'USD');
  let publishedId = sub.entity_id;
  await knex.transaction(async (trx) => {
    if (sub.entity_id) {
      await trx(TABLE[sub.entity]).where({ id: sub.entity_id }).update({ ...data, updated_at: new Date() });
    } else {
      const uni = await trx('universities').where({ id: sub.university_id }).first('slug', 'destination_id', 'currency');
      const base = slugify(`${data.name_en}-${uni.slug}`).slice(0, 130);
      let slug = base; let i = 2;
      while (await trx(TABLE[sub.entity]).where({ slug }).first('id')) { slug = `${base}-${i}`; i += 1; } // eslint-disable-line no-await-in-loop
      const extra = sub.entity === 'program' ? { submitted_by_partner: sub.submitted_by, currency: data.currency || uni.currency || 'USD' } : { destination_id: uni.destination_id, currency: data.currency || uni.currency || 'USD' };
      [publishedId] = await trx(TABLE[sub.entity]).insert({ ...data, ...extra, slug, university_id: sub.university_id });
    }
    await trx('partner_submissions').where({ id }).update({ status: 'approved', review_note: note ? String(note).slice(0, 1000) : null, reviewed_by: ctx.userId, reviewed_at: new Date(), published_id: publishedId, updated_at: new Date() });
  });
  await audit.record(ctx, 'partner.submission_approved', { entityType: TABLE[sub.entity], entityId: publishedId, newValues: { submission: id } });
  await tellPartner(sub, 'approved', note);
  return publishedId;
}

async function decline(ctx, id, status, note) {
  const sub = await knex('partner_submissions').where({ id }).first();
  if (!sub || !['pending', 'changes_requested'].includes(sub.status)) throw E.conflict('NOT_PENDING', 'This submission was already handled.');
  if (!note || !String(note).trim()) throw E.validation({ review_note: 'Tell the university what to change or why it was declined.' });
  await knex('partner_submissions').where({ id }).update({ status, review_note: String(note).slice(0, 1000), reviewed_by: ctx.userId, reviewed_at: new Date(), updated_at: new Date() });
  await audit.record(ctx, `partner.submission_${status}`, { entityType: 'partner_submission', entityId: id });
  await tellPartner(sub, status, note);
}

async function tellPartner(sub, status, note) {
  const user = sub.submitted_by ? await knex('users').where({ id: sub.submitted_by, kind: 'partner' }).first() : null;
  if (!user) return;
  const email = require('../comms/email'); // eslint-disable-line global-require
  const { translator } = require('../../core/i18n'); // eslint-disable-line global-require
  const t = translator(user.locale || 'en');
  const name = parseJson(sub.data).name_en || t('partnerp.entity.university');
  const html = await email.layout({ locale: user.locale || 'en', title: t(`partnerp.mail_${status}_title`), body: `${t(`partnerp.mail_${status}_body`, { name })}${note ? `\n\n${note}` : ''}`, cta: t('partnerp.open_portal'), href: `${config.appUrl}/partner/submissions` });
  await email.send({ to: user.email, subject: t(`partnerp.mail_${status}_title`), html }).catch(() => {});
}

module.exports = { SCHEMAS, TABLE, JSON_FIELDS, parse, membership, apply, invite, approve, reject, submit, diff, approveSubmission, decline, ownedRow, AppError };
