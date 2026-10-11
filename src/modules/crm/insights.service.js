// AI summary of a CRM contact (Admin → CRM → a contact → "AI summary"): reads the contact's stage, quotations and
// timeline and returns a short summary, how interested they look, the next step, a suggested message and risks.
// It runs on the platform's AI settings (Admin → Settings → AI) through the same client and response handling as
// the clinical assistant. E-mails, phone numbers and links are removed from the text before it is sent; the AI only
// suggests — the team decides. The latest summary is kept on the contact.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError } = require('../../core/errors');
const ai = require('../ai/ai.service');
const crm = require('./crm.service');

let injected = null; // tests: a fake SDK client
const setClient = (c) => { injected = c; };

const s = { type: 'string' };
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'interest_level', 'next_action', 'suggested_message', 'risks'],
  properties: { summary: s, interest_level: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] }, next_action: s, suggested_message: s, risks: { type: 'array', items: s } },
};
const fail = (code, status) => new AppError(code, code, status);

/** The text sent: contact facts and the timeline (oldest first), without contact details. */
async function input(c) {
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
  const scrub = (t) => ai.scrubText(String(t || '').slice(0, 500));
  const quotes = await knex('quotes').where({ contact_id: c.id }).orderBy('id').select('number', 'status', 'total', 'currency', 'issue_date', 'view_count');
  const lines = c.activities.slice(0, 80).reverse().map((a) => `[${new Date(a.created_at).toISOString().slice(0, 16).replace('T', ' ')}] ${a.kind}${a.status ? ` (${a.status})` : ''}: ${scrub(a.body)}`);
  return [
    `Kind: ${c.kind} | Stage: ${c.stage} | Source: ${c.source || '-'} | Country: ${c.country || '-'} | City: ${c.city || '-'}`,
    `Added: ${day(c.created_at)} | Next follow-up: ${day(c.next_action_at)} ${scrub(c.next_action)}`,
    c.notes ? `Team notes: ${scrub(c.notes)}` : '',
    quotes.length ? `Quotations: ${quotes.map((q) => `${q.number} ${q.status} ${Number(q.total)} ${q.currency} (opened ${q.view_count}×)`).join('; ')}` : 'Quotations: none',
    '## Timeline (oldest first)', ...(lines.length ? lines : ['(empty)']),
  ].filter(Boolean).join('\n');
}

function params(model, locale, text) {
  return {
    model: model || ai.DEFAULT_MODEL,
    max_tokens: 4000,
    system: [
      'You help the sales team of a clinic-management software platform (clinics, medical centres, drug warehouses and medical reps are its customers).',
      'Summarise one contact from the CRM data given: where things stand, how interested they seem, the single best next step, and a short friendly message the team could send on WhatsApp or e-mail.',
      'Use only the data given; do not invent facts. Placeholders like [email] or [number] replace removed details — ignore them. Keep it brief and practical.',
      locale === 'en' ? 'Write every value in English.' : 'Write every value in clear, friendly Arabic (the suggested message may use a light Levantine tone).',
    ].join('\n'),
    messages: [{ role: 'user', content: `CRM contact:\n\n${text}` }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    betas: [ai.FALLBACK_BETA],
    fallbacks: 'default',
  };
}

async function summarize(ctx, contactId, locale = 'ar', { client } = {}) {
  const platform = await ai.platformSettings();
  if (!platform.active) throw fail(platform.hasKey ? 'AI_PLATFORM_OFF' : 'AI_NOT_CONFIGURED', 409);
  const c = await crm.get(contactId);
  const lang = locale === 'en' ? 'en' : 'ar';
  let resp;
  try {
    resp = await (client || injected || ai.makeClient(platform)).beta.messages.create(params(platform.model, lang, await input(c)));
  } catch (err) {
    const code = ai.errorCode(err);
    await audit.record(ctx, 'crm.ai_summary', { entityType: 'crm_contact', entityId: c.id, newValues: { status: 'error', code } });
    throw fail(code, ai.httpFor(code));
  }
  const r = ai.parseResponse(resp);
  await audit.record(ctx, 'crm.ai_summary', { entityType: 'crm_contact', entityId: c.id, newValues: { status: r.status, model: r.model, input_tokens: r.usage.input, output_tokens: r.usage.output } });
  if (r.status !== 'ok') throw fail(r.code, ai.httpFor(r.code));
  const result = { ...r.result, locale: lang, model: r.model || platform.model };
  await knex('crm_contacts').where({ id: c.id }).update({ ai_summary: JSON.stringify(result), ai_summary_at: new Date() });
  return result;
}

const read = (c) => { try { return c && c.ai_summary ? JSON.parse(c.ai_summary) : null; } catch { return null; } };

module.exports = { SCHEMA, input, params, summarize, read, setClient };
