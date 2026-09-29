// ============================================================================
// Verified reviews. Only a patient who really visited (appointment completed or paid) can review, through the
// secret /review/<token> link sent after the visit (valid 30 days, one review per appointment).
//   • the clinic sees its reviews, replies publicly once per review and may report one to the platform — it can
//     never edit or delete a review (there is deliberately no such function here)
//   • the platform admin hides abusive reviews with a reason (audited) and can show them again
//   • public: average, count, distribution, latest reviews with replies, per-doctor averages, JSON-LD data
//   • nothing public ever includes the patient's phone, e-mail or visit details
// ============================================================================
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { sha256 } = require('../../core/tokens');
const { z, validate, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const notifications = require('../notifications/notification.service');
const { translator } = require('../../core/i18n');

const DISPLAY = ['full', 'initials', 'anonymous'];
const MAX_COMMENT = 1000;
const PUBLIC_LATEST = 6;

const visited = (a) => a && a.appointment_type !== 'blocked' && !['cancelled', 'no_show'].includes(a.status) && (a.status === 'completed' || a.payment_status === 'paid');

/**
 * Whether a review link can be used now: 'ok' | 'expired' | 'not_visited' | 'done'.
 * @param link row from messaging.byToken(token, 'review')
 */
async function linkState(link, now = Date.now()) {
  if (!link) return 'expired';
  if (!link.expires_at || new Date(link.expires_at).getTime() <= now) return 'expired';
  if (await knex('reviews').where({ appointment_id: link.id }).first('id')) return 'done';
  if (!visited(link)) return 'not_visited';
  return 'ok';
}

const star = (required) => {
  const s = z.preprocess((v) => (v === '' || v === undefined || v === null ? undefined : Number(v)), z.number({ invalid_type_error: 'Choose a valid value.' }).int('Choose a valid value.').min(1, 'Choose a valid value.').max(5, 'Choose a valid value.'));
  return required ? s.refine((v) => v !== undefined, 'Required.') : s.optional();
};
const reviewSchema = z.object({
  rating: z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number({ required_error: 'Required.', invalid_type_error: 'Required.' }).int().min(1, 'Required.').max(5, 'Required.')),
  rating_doctor: star(false), rating_wait: star(false), rating_clinic: star(false),
  comment: z.preprocess(emptyToUndefined, z.string().trim().max(MAX_COMMENT, `Must be at most ${MAX_COMMENT} characters.`).optional()),
  display_mode: z.enum(DISPLAY, { errorMap: () => ({ message: 'Choose a valid value.' }) }).default('initials'),
});

function displayName(fullName, mode) {
  const name = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (mode === 'anonymous' || !name) return null;
  if (mode === 'full') return name.slice(0, 120);
  return name.split(' ').slice(0, 3).map((p) => `${p[0]}.`).join(' ');
}

/** Stores the review of a visited appointment (link from messaging.byToken). */
async function submit(link, input, meta = {}) {
  const state = await linkState(link);
  if (state === 'done') throw new AppError('REVIEW_EXISTS', 'This visit has already been reviewed.', 409);
  if (state === 'not_visited') throw new AppError('REVIEW_NOT_VISITED', 'Only patients who visited the clinic can review.', 403);
  if (state !== 'ok') throw new AppError('REVIEW_LINK_EXPIRED', 'This review link has expired.', 410);
  const d = validate(reviewSchema, input);
  const patient = link.patient_id ? await knex('patients').where({ id: link.patient_id, business_id: link.business_id }).first('full_name') : null;
  let id;
  try {
    [id] = await knex('reviews').insert({
      business_id: link.business_id, appointment_id: link.id, doctor_id: link.doctor_id || null, patient_id: link.patient_id || null,
      rating: d.rating, rating_doctor: d.rating_doctor ?? null, rating_wait: d.rating_wait ?? null, rating_clinic: d.rating_clinic ?? null,
      comment: d.comment || null, locale: meta.locale === 'en' ? 'en' : 'ar', display_mode: d.display_mode,
      display_name: displayName((patient && patient.full_name) || link.patient_name, d.display_mode),
      visit_date: link.appointment_date, ip_hash: meta.ip ? sha256(`review:${meta.ip}`) : null,
    });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') throw new AppError('REVIEW_EXISTS', 'This visit has already been reviewed.', 409);
    throw err;
  }
  await knex('appointment_links').where({ id: link.link_id }).update({ used_at: new Date() });
  await audit.record({ businessId: link.business_id, userId: null, ip: meta.ip, userAgent: meta.userAgent }, 'review.submitted', { entityType: 'review', entityId: id, newValues: { rating: d.rating, appointment_id: link.id } });
  const cfg = await knex('clinic_messaging').where({ business_id: link.business_id }).first('message_locale');
  const t = translator(cfg && cfg.message_locale === 'en' ? 'en' : 'ar');
  await notifications.notify(link.business_id, { permission: 'reviews.manage', type: 'review.new', severity: d.rating <= 2 ? 'warning' : 'info', title: t('reviews.notify_new', { n: d.rating }), link: `/app/reviews?focus=${id}` });
  return id;
}

// ---------------------------------------------------------------- clinic side
function scoped(ctx) {
  const q = knex('reviews as r').leftJoin('doctors as d', 'd.id', 'r.doctor_id').where('r.business_id', ctx.businessId);
  if (ctx.ownDoctorId) q.where('r.doctor_id', ctx.ownDoctorId); // a doctor sees the reviews of their own visits
  return q;
}

async function list(ctx, { doctor, rating, status, page = 1 } = {}) {
  const per = 20;
  const q = scoped(ctx);
  if (doctor && doctor !== 'all') q.where('r.doctor_id', Number(doctor));
  if (rating && /^[1-5]$/.test(String(rating))) q.where('r.rating', Number(rating));
  if (status === 'hidden') q.where('r.status', 'hidden'); else if (status === 'reported') q.whereNotNull('r.reported_at'); else if (status === 'unanswered') q.whereNull('r.reply').where('r.status', 'published');
  const [{ n }] = await q.clone().count({ n: '*' });
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / per));
  const cur = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = await q.orderBy('r.id', 'desc').limit(per).offset((cur - 1) * per)
    .select('r.id', 'r.rating', 'r.rating_doctor', 'r.rating_wait', 'r.rating_clinic', 'r.comment', 'r.locale', 'r.display_mode', 'r.display_name', 'r.visit_date', 'r.status',
      'r.hidden_reason', 'r.reported_at', 'r.report_reason', 'r.reply', 'r.replied_at', 'r.created_at', 'r.doctor_id', 'r.appointment_id', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.color as doctor_color');
  return { rows, meta: { total, page: cur, pages, perPage: per } };
}

/** Average, count and 1–5 distribution (published reviews) for the clinic, or one doctor. */
async function stats(ctx, { doctor } = {}) {
  const q = scoped(ctx).where('r.status', 'published');
  if (doctor && doctor !== 'all') q.where('r.doctor_id', Number(doctor));
  const rows = await q.clone().groupBy('r.rating').select('r.rating').count({ n: '*' });
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  rows.forEach((r) => { dist[r.rating] = Number(r.n); });
  const count = Object.values(dist).reduce((s, v) => s + v, 0);
  const avg = count ? Object.entries(dist).reduce((s, [k, v]) => s + Number(k) * v, 0) / count : null;
  const [subs] = await q.clone().select(knex.raw('AVG(r.rating_doctor) as doctor, AVG(r.rating_wait) as wait, AVG(r.rating_clinic) as clinic'));
  const [{ unanswered }] = await scoped(ctx).where('r.status', 'published').whereNull('r.reply').count({ unanswered: '*' });
  return { count, avg, dist, subs: { doctor: subs.doctor != null ? Number(subs.doctor) : null, wait: subs.wait != null ? Number(subs.wait) : null, clinic: subs.clinic != null ? Number(subs.clinic) : null }, unanswered: Number(unanswered) };
}

async function getOwn(ctx, id) {
  const r = await scoped(ctx).where('r.id', Number(id)).first('r.*');
  if (!r) throw E.notFound('Review');
  return r;
}

const replySchema = z.object({ reply: z.string().trim().min(2, 'Required.').max(MAX_COMMENT, `Must be at most ${MAX_COMMENT} characters.`) });

/** The clinic's public answer — one per review, final once published (no editing, like the review itself). */
async function reply(ctx, id, input) {
  const r = await getOwn(ctx, id);
  const d = validate(replySchema, input);
  const n = await knex('reviews').where({ id: r.id, business_id: ctx.businessId }).whereNull('reply').update({ reply: d.reply, reply_by: ctx.userId, replied_at: new Date(), updated_at: new Date() });
  if (!n) throw new AppError('REVIEW_REPLIED', 'This review already has a reply.', 409);
  await audit.record(ctx, 'review.replied', { entityType: 'review', entityId: r.id, newValues: { reply: d.reply } });
}

const reportSchema = z.object({ reason: z.string().trim().min(3, 'Required.').max(500, 'Must be at most 500 characters.') });

/** Flags a review for the platform's moderators. The review stays visible until the platform decides. */
async function report(ctx, id, input) {
  const r = await getOwn(ctx, id);
  const d = validate(reportSchema, input);
  if (r.reported_at) throw new AppError('REVIEW_REPORTED', 'This review has already been reported.', 409);
  await knex('reviews').where({ id: r.id, business_id: ctx.businessId }).update({ reported_at: new Date(), report_reason: d.reason, reported_by: ctx.userId, updated_at: new Date() });
  await audit.record(ctx, 'review.reported', { entityType: 'review', entityId: r.id, newValues: { reason: d.reason } });
}

// ---------------------------------------------------------------- platform moderation
async function adminList({ status, q, page = 1 } = {}) {
  const per = 25;
  const base = knex('reviews as r').join('businesses as b', 'b.id', 'r.business_id').leftJoin('doctors as d', 'd.id', 'r.doctor_id');
  if (status === 'reported') base.whereNotNull('r.reported_at').where('r.status', 'published');
  else if (status === 'hidden') base.where('r.status', 'hidden');
  if (q) { const s = `%${String(q).trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`; base.andWhere((w) => w.where('b.name', 'like', s).orWhere('b.slug', 'like', s).orWhere('r.comment', 'like', s)); }
  const [{ n }] = await base.clone().count({ n: '*' });
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / per));
  const cur = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = await base.orderByRaw('r.reported_at IS NULL, r.id DESC').limit(per).offset((cur - 1) * per)
    .select('r.id', 'r.rating', 'r.comment', 'r.display_name', 'r.display_mode', 'r.status', 'r.hidden_reason', 'r.hidden_at', 'r.reported_at', 'r.report_reason', 'r.reply', 'r.created_at',
      'b.id as business_id', 'b.name as clinic_name', 'b.name_en as clinic_name_en', 'b.slug', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en');
  const [counts] = await knex('reviews').select(knex.raw("SUM(reported_at IS NOT NULL AND status = 'published') as reported, SUM(status = 'hidden') as hidden, COUNT(*) as total"));
  return { rows, meta: { total, page: cur, pages, perPage: per }, counts: { reported: Number(counts.reported || 0), hidden: Number(counts.hidden || 0), total: Number(counts.total || 0) } };
}

const hideSchema = z.object({ reason: z.string().trim().min(3, 'Required.').max(500, 'Must be at most 500 characters.') });

async function moderate(ctx, id, action, input = {}) {
  const r = await knex('reviews').where({ id: Number(id) }).first();
  if (!r) throw E.notFound('Review');
  if (action === 'hide') {
    const d = validate(hideSchema, input);
    await knex('reviews').where({ id: r.id }).update({ status: 'hidden', hidden_reason: d.reason, hidden_by: ctx.userId, hidden_at: new Date(), updated_at: new Date() });
    await audit.record(ctx, 'platform.review_hidden', { entityType: 'review', entityId: r.id, oldValues: { status: r.status }, newValues: { status: 'hidden', reason: d.reason, business_id: r.business_id } });
  } else if (action === 'show') {
    await knex('reviews').where({ id: r.id }).update({ status: 'published', hidden_reason: null, hidden_by: null, hidden_at: null, updated_at: new Date() });
    await audit.record(ctx, 'platform.review_restored', { entityType: 'review', entityId: r.id, oldValues: { status: r.status, reason: r.hidden_reason }, newValues: { status: 'published', business_id: r.business_id } });
  } else if (action === 'dismiss') {
    await knex('reviews').where({ id: r.id }).update({ reported_at: null, updated_at: new Date() });
    await audit.record(ctx, 'platform.review_report_dismissed', { entityType: 'review', entityId: r.id, oldValues: { report_reason: r.report_reason }, newValues: { business_id: r.business_id } });
  } else throw E.validation({ action: 'Choose a valid value.' });
}

// ---------------------------------------------------------------- public (clinic page)
/** Only published reviews; only rating, comment, chosen display name, month of the visit and the clinic's reply. */
async function publicSummary(businessId, { limit = PUBLIC_LATEST } = {}) {
  const base = () => knex('reviews').where({ business_id: businessId, status: 'published' });
  const rows = await base().groupBy('rating').select('rating').count({ n: '*' });
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  rows.forEach((r) => { dist[r.rating] = Number(r.n); });
  const count = Object.values(dist).reduce((s, v) => s + v, 0);
  if (!count) return { count: 0, avg: null, dist, latest: [], byDoctor: {} };
  const avg = Object.entries(dist).reduce((s, [k, v]) => s + Number(k) * v, 0) / count;
  const latest = await knex('reviews as r').leftJoin('doctors as d', 'd.id', 'r.doctor_id').where({ 'r.business_id': businessId, 'r.status': 'published' })
    .orderBy('r.id', 'desc').limit(limit)
    .select('r.id', 'r.rating', 'r.comment', 'r.locale', 'r.display_name', 'r.created_at', 'r.reply', 'r.replied_at', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en');
  const docs = await base().whereNotNull('doctor_id').groupBy('doctor_id').select('doctor_id', knex.raw('AVG(rating) as avg'), knex.raw('COUNT(*) as n'));
  const byDoctor = Object.fromEntries(docs.map((d) => [d.doctor_id, { avg: Number(d.avg), count: Number(d.n) }]));
  return { count, avg, dist, latest, byDoctor };
}

/** schema.org AggregateRating + Review items for the clinic's MedicalClinic data (null without reviews). */
function jsonLd(summary, locale) {
  if (!summary || !summary.count) return null;
  return {
    aggregateRating: { '@type': 'AggregateRating', ratingValue: Number(summary.avg.toFixed(1)), reviewCount: summary.count, bestRating: 5, worstRating: 1 },
    review: summary.latest.slice(0, 5).map((r) => ({
      '@type': 'Review', reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5, worstRating: 1 },
      author: { '@type': 'Person', name: r.display_name || (locale === 'en' ? 'Verified patient' : 'مراجع موثّق') },
      datePublished: new Date(r.created_at).toISOString().slice(0, 10), ...(r.comment ? { reviewBody: String(r.comment).slice(0, 500) } : {}),
    })),
  };
}

module.exports = { DISPLAY, MAX_COMMENT, visited, linkState, submit, displayName, list, stats, getOwn, reply, report, adminList, moderate, publicSummary, jsonLd };
