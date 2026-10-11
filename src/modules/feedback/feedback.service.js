// How likely the clinic is to recommend the platform (NPS, 0–10, and a comment): asked of the clinic's owner after
// 30 days of use, then every 90 days; "not now" asks again after 14 days. The answer goes on the clinic's CRM
// timeline, and a low score (0–6) alerts the platform admins so someone calls before the clinic leaves.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');

const DAY = 86_400_000;
const AFTER_DAYS = 30; const EVERY_DAYS = 90; const LATER_DAYS = 14;

/** Should this page ask (the owner, a clinic old enough, nothing answered or postponed recently)? */
async function shouldAsk(ctx, business, now = new Date()) {
  if (!business || ctx.roleKey !== 'owner' || business.kind === 'center_admin') return false;
  if (require('../../config/edition').single) return false; // eslint-disable-line global-require -- a clinic's own server: no platform to rate
  if (!business.created_at || now - new Date(business.created_at) < AFTER_DAYS * DAY) return false;
  const last = await knex('nps_responses').where({ business_id: business.id }).orderBy('id', 'desc').first('score', 'created_at');
  if (!last) return true;
  const age = now - new Date(last.created_at);
  return last.score === null ? age >= LATER_DAYS * DAY : age >= EVERY_DAYS * DAY;
}

async function answer(ctx, business, body) {
  const later = body.later === '1';
  const score = later ? null : Number.parseInt(body.score, 10);
  if (!later && !(Number.isInteger(score) && score >= 0 && score <= 10)) throw E.validation({ score: 'Choose a number from 0 to 10.' });
  const comment = later ? null : String(body.comment || '').trim().slice(0, 1000) || null;
  await knex('nps_responses').insert({ business_id: business.id, user_id: ctx.userId || null, score, comment });
  if (later) return null;
  await audit.record(ctx, 'feedback.nps', { entityType: 'business', entityId: business.id, newValues: { score } });
  const contact = await knex('crm_contacts').where({ business_id: business.id }).first('id');
  if (contact) await require('../crm/crm.service').log({ userId: ctx.userId }, contact.id, 'event', `NPS ${score}/10${comment ? `\n${comment}` : ''}`).catch(() => {}); // eslint-disable-line global-require
  if (score <= 6) await require('../platformnotify/notify.service').admin('nps_low', { clinic: business.name, score }, { link: contact ? `/admin/crm/${contact.id}` : `/admin/clinics/${business.id}`, severity: 'warning' }).catch(() => {}); // eslint-disable-line global-require
  return score;
}

/** The platform's score (promoters − detractors, %) and the count, over the last `days`. */
async function score(days = 180, now = new Date()) {
  const rows = await knex('nps_responses').whereNotNull('score').where('created_at', '>=', new Date(now - days * DAY)).orderBy('id', 'desc').select('business_id', 'score');
  const latest = new Map(); rows.forEach((r) => { if (!latest.has(r.business_id)) latest.set(r.business_id, r.score); }); // one per clinic: its latest
  const s = [...latest.values()];
  if (!s.length) return { nps: null, n: 0, promoters: 0, detractors: 0 };
  const promoters = s.filter((x) => x >= 9).length; const detractors = s.filter((x) => x <= 6).length;
  return { nps: Math.round(((promoters - detractors) / s.length) * 100), n: s.length, promoters, detractors };
}

module.exports = { shouldAsk, answer, score, AFTER_DAYS };
