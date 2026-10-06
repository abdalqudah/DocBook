// AI study advisor. With an AI provider connected, Claude answers using only GEC's database through read-only
// tools (search programs, program details, match check, scholarships, costs, checklist). Without one, the advisor
// says so plainly and runs a database search on the question instead — it never invents an answer.
const knex = require('../../db/knex');
const finder = require('../catalog/finder.service');
const matching = require('../catalog/matching.service');
const { markdown } = require('../../core/markdown');
const tools = require('./tools');
const provider = require('./provider');

const MAX_TURNS = 6;
const HISTORY = 8;

function systemPrompt(locale, student) {
  return [
    'You are the study-abroad advisor of GEC (Global Education Consultants). You help students find programs, compare universities, understand requirements and scholarships, estimate costs, and see their next steps.',
    'Only state facts that come from your tools, which read GEC’s own database. Never invent programs, universities, fees, deadlines, requirements or scholarships. If the tools return nothing, or a value is "not published", say so and suggest booking a free consultation (/book) or checking the official page.',
    'Results marked demo_data are sample data: say they are examples to be verified. Admission is decided by universities: never promise or predict admission. Visa and immigration information is general guidance, not legal advice.',
    'Link programs and scholarships with the url the tools return, in Markdown, e.g. [MSc Data Science](/programs/msc-data-science). Keep answers short and scannable: a sentence or two, then a short list. Ask one clarifying question when the request is too vague to search.',
    `Answer in ${locale === 'ar' ? 'Arabic' : 'English'} unless the student writes in another language.`,
    student ? 'The student is signed in; check_match uses their saved profile.' : 'The visitor is not signed in; if they give IELTS, grades or budget, pass them to check_match.',
  ].join('\n');
}

/** Numbers a visitor typed: "IELTS 6.5", "$20,000", "20k". */
function figuresIn(q) {
  const s = String(q).replace(/,/g, '');
  const ielts = /ielts\D{0,10}(\d(?:\.\d)?)/i.exec(s) || /(\d\.\d)\s*(?:in\s*)?ielts/i.exec(s) || /آيلتس\D{0,10}(\d(?:\.\d)?)/.exec(s);
  const budget = /(?:\$|usd\s*)(\d{4,6})|(\d{4,6})\s*(?:\$|usd|dollars|دولار)|(\d{2,3})\s*k\b/i.exec(s);
  return { ielts: ielts ? Number(ielts[1]) : null, budget: budget ? Number(budget[1] || budget[2] || Number(budget[3]) * 1000) : null };
}

/** No AI connected: a plain database search on the question, clearly labelled as such. */
async function searchMode(question, student) {
  const parsed = await finder.parseQuery(question);
  const fig = figuresIn(question);
  // Structured filters from the question; leftover words only count when they look like a name (no numbers, short).
  const rest = String(parsed.text || '').replace(/[\d.$]+|ielts|budget|annual|year|have|want|with|and|my|i|a/gi, ' ').trim().split(/\s+/).filter(Boolean);
  const params = { q: rest.length && rest.length <= 3 && !parsed.degree && !parsed.field ? rest.join(' ') : '', degree: parsed.degree || '', field: parsed.field || '', destination: parsed.destination || '', ielts: fig.ielts || '', sort: fig.budget ? 'tuition_asc' : 'relevance' };
  let r = await finder.search({ ...params, max_tuition: fig.budget || '' });
  let overBudget = false;
  if (!r.total && fig.budget) { r = await finder.search(params); overBudget = r.total > 0; } // nothing within budget: show the closest, clearly flagged
  const profile = student ? matching.profileOf(student) : matching.profileOf({ ielts_overall: fig.ielts, budget_usd: fig.budget });
  const programs = [];
  for (const raw of r.rows.slice(0, 6)) {
    const [p] = await knex('programs as p').join('universities as u', 'u.id', 'p.university_id').leftJoin('destinations as d', 'd.id', 'u.destination_id').where('p.id', raw.id).select([...finder.COLUMNS, 'd.living_month_min', 'd.living_month_max', 'd.currency as dest_currency']); // eslint-disable-line no-await-in-loop
    const match = (profile.ielts || profile.budget || student) ? await matching.evaluate(profile, finder.shape(p)) : null; // eslint-disable-line no-await-in-loop
    programs.push({ program: tools.programCard(raw), match });
  }
  return { mode: 'search', total: r.total, parsed, figures: fig, programs, overBudget };
}

/** Answers a question. `history` = [{ role, text }] kept by the caller (session). */
async function ask({ question, locale = 'en', student = null, history = [], userId = null, sessionKey = null }) {
  const cfg = await provider.currentConfig();
  if (!cfg) {
    const out = await searchMode(question, student);
    await knex('advisor_logs').insert({ user_id: userId, session_key: sessionKey, question: String(question).slice(0, 4000), mode: 'search', answer: JSON.stringify({ total: out.total, ids: out.programs.map((p) => p.program.id) }) });
    return out;
  }
  const defs = await tools.definitions();
  const messages = [...history.slice(-HISTORY).map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: String(question).slice(0, 4000) }];
  const used = []; let usage = { input_tokens: 0, output_tokens: 0 }; let text = ''; let model = cfg.model; let error = null;
  try {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const res = await provider.chat(cfg, { system: systemPrompt(locale, student), messages, tools: defs }); // eslint-disable-line no-await-in-loop
      model = res.model || model;
      usage = { input_tokens: usage.input_tokens + ((res.usage && res.usage.input_tokens) || 0), output_tokens: usage.output_tokens + ((res.usage && res.usage.output_tokens) || 0) };
      if (res.stopReason === 'refusal') { text = locale === 'ar' ? 'لا أستطيع المساعدة في هذا الطلب. يمكنك حجز استشارة مجانية مع مستشار.' : 'I can’t help with that request. You can book a free consultation with a counsellor.'; break; }
      messages.push({ role: 'assistant', content: res.content });
      const calls = res.content.filter((b) => b.type === 'tool_use');
      if (res.stopReason !== 'tool_use' || !calls.length) { text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(); break; }
      const results = [];
      for (const c of calls) {
        let out;
        try { out = await tools.run(c.name, c.input, { student }); } catch (e) { out = { error: e.message }; } // eslint-disable-line no-await-in-loop
        used.push({ name: c.name, input: c.input });
        results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out), ...(out && out.error ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
    if (!text) text = locale === 'ar' ? 'لم أتمكن من إكمال الإجابة. جرّب سؤالاً أبسط أو احجز استشارة.' : 'I couldn’t finish that answer. Try a simpler question or book a consultation.';
  } catch (e) {
    error = e.message;
    const out = await searchMode(question, student);
    await knex('advisor_logs').insert({ user_id: userId, session_key: sessionKey, question: String(question).slice(0, 4000), mode: 'search', provider: cfg.provider, model, error: String(error).slice(0, 255) });
    return { ...out, aiError: true };
  }
  await knex('advisor_logs').insert({ user_id: userId, session_key: sessionKey, question: String(question).slice(0, 4000), answer: text.slice(0, 60000), mode: 'ai', provider: cfg.provider, model, tools: JSON.stringify(used), input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
  return { mode: 'ai', text, html: markdown(text), tools: used.map((u) => u.name) };
}

module.exports = { ask, figuresIn, searchMode, systemPrompt };
