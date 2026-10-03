// The clinic's own wording of patient messages (Settings → Message texts). Every editable message has a DocBook
// default in the translation files; a clinic may replace it in Arabic and/or English. Placeholders such as {clinic}
// and {link} are filled when sending. Also where the "rate your visit" link points (Google or the clinic's site).
//   translatorFor(businessId, locale) → t(key, vars): the clinic's text when it wrote one, else DocBook's
//   reviewTarget(businessId)           → 'auto' | 'google' | 'site'
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { translator } = require('../../core/i18n');

// group → messages; vars = the placeholders the text may use (shown under the field).
const GROUPS = [
  { key: 'booking', items: [
    { key: 'messaging.text.received', vars: ['clinic', 'date', 'time'] },
    { key: 'messaging.text.confirmation', vars: ['clinic', 'doctor', 'date', 'time', 'link'] },
    { key: 'messaging.text.confirmed', vars: ['clinic', 'doctor', 'date', 'time', 'link'] },
    { key: 'messaging.text.reminder', vars: ['clinic', 'doctor', 'date', 'time', 'link'] },
    { key: 'messaging.text.cancelled', vars: ['clinic', 'doctor', 'date', 'time', 'link'] },
  ] },
  // The e-mail version of the appointment messages (subject + text; the link is the button under the text).
  { key: 'email', items: ['received', 'confirmation', 'confirmed', 'reminder', 'cancelled', 'review'].flatMap((k) => [
    { key: `messaging.mail.${k}_subject`, vars: ['clinic', 'doctor', 'date', 'time'], line: true },
    { key: `messaging.mail.${k}_body`, vars: ['clinic', 'doctor', 'date', 'time'] },
  ]) },
  { key: 'papers', items: [
    { key: 'share.message', vars: ['name', 'clinic', 'doc', 'link', 'date'] },
    { key: 'share.mail_subject', vars: ['name', 'clinic', 'doc'], line: true },
    { key: 'share.mail_body', vars: ['name', 'clinic', 'doc', 'date'] },
  ] },
  { key: 'partners', items: [
    { key: 'share.partner_message', vars: ['partner', 'clinic', 'doc', 'name', 'link', 'date'] },
    { key: 'share.partner_mail_subject', vars: ['partner', 'clinic', 'doc', 'name'], line: true },
    { key: 'share.partner_mail_body', vars: ['partner', 'clinic', 'doc', 'name', 'date'] },
  ] },
  { key: 'surgeries', items: [
    { key: 'surgeries.msg.wa', vars: ['hospital', 'clinic', 'doctor', 'name', 'phone', 'procedure', 'date', 'time', 'notes'] },
    { key: 'surgeries.msg.mail_subject', vars: ['hospital', 'clinic', 'doctor', 'name', 'procedure', 'date'], line: true },
    { key: 'surgeries.msg.mail_body', vars: ['hospital', 'clinic', 'doctor', 'name', 'phone', 'procedure', 'date', 'time', 'notes'] },
  ] },
  { key: 'payroll', items: [
    { key: 'payouts.msg.slip_subject', vars: ['name', 'clinic', 'period'], line: true },
    { key: 'payouts.msg.slip_body', vars: ['name', 'clinic', 'period'] },
    { key: 'payouts.msg.bank_subject', vars: ['bank', 'clinic', 'period'], line: true },
    { key: 'payouts.msg.bank_body', vars: ['bank', 'clinic', 'period', 'count', 'total', 'account'] },
  ] },
  { key: 'insurance', items: [
    { key: 'inscl.msg.subject', vars: ['company', 'clinic', 'from', 'to'], line: true },
    { key: 'inscl.msg.body', vars: ['company', 'clinic', 'from', 'to', 'count', 'total'] },
  ] },
  { key: 'after', items: [
    { key: 'share.thanks_message', vars: ['name', 'clinic', 'link'] },
    { key: 'messaging.text.review', vars: ['clinic', 'doctor', 'link'] },
  ] },
];
const KEYS = GROUPS.flatMap((g) => g.items.map((i) => i.key));
const TARGETS = ['auto', 'google', 'site'];
const MAX = 700;

const parse = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) || {}; } catch { return {}; } };
const row = (businessId) => cache.remember(`msgtexts:${businessId}`, async () => {
  const r = await knex('clinic_messages').where({ business_id: businessId }).first('texts', 'review_target');
  return { texts: parse(r && r.texts), reviewTarget: TARGETS.includes(r && r.review_target) ? r.review_target : 'auto' };
}, 60_000);

const fill = (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));

/** A translator that uses the clinic's own text for the editable messages. */
async function translatorFor(businessId, locale) {
  const base = translator(locale);
  const { texts } = businessId ? await row(businessId) : { texts: {} };
  return (key, vars) => {
    const own = texts[key] && texts[key][locale];
    return own ? fill(own, vars) : base(key, vars);
  };
}

async function reviewTarget(businessId) { return (await row(businessId)).reviewTarget; }

/** The clinic's own text for one message and language, or null (DocBook's default applies). */
async function ownText(businessId, key, locale) {
  const { texts } = await row(businessId);
  return (texts[key] && texts[key][locale]) || null;
}

/**
 * The Google review link to use instead of the clinic's own review page, or null:
 * google → always when the clinic set a link; auto → only for the thank-you message staff send (manual); site → never.
 */
async function googleReviewLink(businessId, { manual = false } = {}) {
  const target = await reviewTarget(businessId);
  if (target === 'site' || (target === 'auto' && !manual)) return null;
  const m = await require('../website/marketing.service').get(businessId); // eslint-disable-line global-require
  return (m && m.google && m.google.review) || null;
}

/** For the settings page: every message with DocBook's default and the clinic's text, per language. */
async function forPage(businessId) {
  const { texts, reviewTarget: target } = await row(businessId);
  const ar = translator('ar'); const en = translator('en');
  return {
    reviewTarget: target,
    groups: GROUPS.map((g) => ({ key: g.key, items: g.items.map((i) => ({ ...i, def: { ar: ar(i.key), en: en(i.key) }, own: { ar: (texts[i.key] && texts[i.key].ar) || '', en: (texts[i.key] && texts[i.key].en) || '' } })) })),
  };
}

const clean = (v, line) => {
  const s = String(Array.isArray(v) ? v[v.length - 1] : v || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim().slice(0, MAX);
  return line ? s.replace(/\s*\n\s*/g, ' ') : s;
};

/** Saves the texts (input t[<key>][ar|en]); a text equal to DocBook's default, or empty, means "use the default". */
async function save(ctx, input) {
  const src = (input && input.t) || {};
  const ar = translator('ar'); const en = translator('en');
  const texts = {};
  for (const g of GROUPS) for (const i of g.items) { // eslint-disable-line no-restricted-syntax
    const v = src[i.key] || {};
    const out = {};
    for (const [lang, tr] of [['ar', ar], ['en', en]]) {
      const s = clean(v[lang], i.line);
      if (s && s !== tr(i.key)) out[lang] = s;
    }
    if (Object.keys(out).length) texts[i.key] = out;
  }
  const target = TARGETS.includes(input.review_target) ? input.review_target : 'auto';
  const now = new Date();
  await knex('clinic_messages').insert({ business_id: ctx.businessId, texts: JSON.stringify(texts), review_target: target, updated_by: ctx.userId || null, created_at: now, updated_at: now })
    .onConflict('business_id').merge({ texts: JSON.stringify(texts), review_target: target, updated_by: ctx.userId || null, updated_at: now });
  cache.forgetPrefix(`msgtexts:${ctx.businessId}`);
  await audit.record(ctx, 'messaging.texts_updated', { entityType: 'clinic_messages', entityId: ctx.businessId, newValues: { changed: Object.keys(texts), review_target: target } });
}

module.exports = { GROUPS, KEYS, TARGETS, translatorFor, reviewTarget, ownText, googleReviewLink, forPage, save, fill };
