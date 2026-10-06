const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent, agent, outbox } = require('./helpers');

const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];
let admin; let counsellor; let marketing; let program;
test.before(async () => {
  await resetDb();
  await require('../src/db/seeds/demo-catalog').run();
  admin = await makeStaff({ role: 'super_admin' });
  counsellor = await makeStaff({ role: 'counsellor', name: 'Rana Counsellor' });
  marketing = await makeStaff({ role: 'marketing' });
  program = await knex('programs').first();
});
test.after(() => knex.destroy());

const browser = async (consent, extra = {}) => {
  const a = await agent();
  a.h = (r) => { r.set('User-Agent', 'Mozilla/5.0 (iPhone)'); if (consent) r.set('Cookie', [`gec_consent=${consent}`, ...(a.vid ? [`gec_vid=${a.vid}`] : [])].join('; ')); Object.entries(extra).forEach(([k, v]) => r.set(k, v)); return r; };
  a.visit = async (path) => { const r = await a.h(a.get(path)); const m = /gec_vid=([^;]+)/.exec((r.headers['set-cookie'] || []).join(';')); if (m) a.vid = m[1]; return r; };
  return a;
};

test('tracking happens only with consent, never with Global Privacy Control, and links the visit to the enquiry', async () => {
  const none = await browser(null);
  await none.visit('/');
  const gpc = await browser('all', { 'Sec-GPC': '1' });
  await gpc.visit('/');
  const bot = await agent();
  await bot.get('/').set('User-Agent', 'Googlebot/2.1').set('Cookie', 'gec_consent=all');
  assert.equal(Number((await knex('visitors').count({ n: '*' }))[0].n), 0, 'no visitor without consent, with GPC, or for bots');

  const v = await browser('all');
  await v.visit('/?utm_source=google&utm_medium=cpc&utm_campaign=uk-masters');
  assert.ok(v.vid, 'first-party visitor cookie set after consent');
  await v.visit(`/programs/${program.slug}`);
  const visitor = await knex('visitors').where({ id: v.vid }).first();
  assert.equal(visitor.utm_campaign, 'uk-masters'); assert.equal(visitor.device, 'mobile');
  const names = await knex('tracking_events').where({ visitor_id: v.vid }).pluck('name');
  assert.ok(names.includes('pageview') && names.includes('program_view'));
  const form = await v.visit('/book');
  const r = await v.h(v.post('/book')).type('form').send({ _csrf: csrfOf(form.text), first_name: 'Tariq', email: 'tariq@example.com', interest_degree: 'master', interest_countries: 'uk', consent_contact: '1', contact_time: 'any' });
  assert.equal(r.status, 302);
  const lead = await knex('leads').where({ email: 'tariq@example.com' }).first();
  assert.equal(lead.visitor_id, v.vid);
  assert.equal(lead.utm_campaign, 'uk-masters', 'first-touch campaign kept from the earlier visit');
  assert.equal((await knex('visitors').where({ id: v.vid }).first()).lead_id, lead.id);
  // beacon accepts only known event names
  const t = csrfOf(form.text);
  await v.h(v.post('/t/e')).set('X-CSRF-Token', t).send({ name: 'phone_click', path: '/contact' });
  await v.h(v.post('/t/e')).set('X-CSRF-Token', t).send({ name: '<script>', path: '/x' });
  const evs = await knex('tracking_events').where({ visitor_id: v.vid }).pluck('name');
  assert.ok(evs.includes('phone_click')); assert.ok(!evs.includes('<script>'));
  // the counsellor sees the website activity on the lead
  const ad = await staffAgent(admin);
  assert.match((await ad.get(`/staff/leads/${lead.id}`)).text, /Viewed program/);
  // withdrawing consent deletes the browsing history but keeps the lead
  const w = await v.h(v.post('/t/consent')).set('X-CSRF-Token', t).send({ consent: 'necessary' });
  assert.equal(w.status, 204);
  assert.equal(await knex('visitors').where({ id: v.vid }).first(), undefined);
  assert.equal(Number((await knex('tracking_events').where({ visitor_id: v.vid }).count({ n: '*' }))[0].n), 0);
  assert.ok(await knex('leads').where({ id: lead.id }).first());
});

test('lead scoring explains itself, follows the settings, and respects a manual temperature', async () => {
  const scoring = require('../src/modules/growth/scoring');
  const leads = require('../src/modules/crm/leads.service');
  const { lead } = await leads.capture({ userId: null }, { first_name: 'Hala', email: 'hala@example.com', phone: '0790000000', interest_degree: 'master', interest_countries: ['uk'], budget_range: '20_35', interest_intake: new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 7) }, { source: 'referral' }, {});
  const r = await scoring.compute(lead.id);
  const keys = r.reasons.map((x) => x.key);
  for (const k of ['has_email', 'has_phone', 'degree_known', 'destination_known', 'budget_known', 'intake_6_months', 'source_referral']) assert.ok(keys.includes(k), k);
  assert.equal(r.score, 55); assert.equal(r.temperature, 'warm');
  const ad = await staffAgent(admin);
  const t = await ad.token();
  const body = { _csrf: t, warm: '20', hot: '50' };
  for (const k of Object.keys(scoring.RULES)) { body[`points_${k}`] = String(scoring.RULES[k].points); body[`enabled_${k}`] = '1'; }
  body.points_source_referral = '20';
  assert.equal((await ad.post('/staff/settings/scoring').type('form').send(body)).status, 302);
  const after = await knex('leads').where({ id: lead.id }).first();
  assert.equal(after.score, 65); assert.equal(after.temperature, 'hot', 'recalculated with the new points and thresholds');
  await ad.post(`/staff/leads/${lead.id}/temperature`).type('form').send({ _csrf: t, temperature: 'cold' });
  await scoring.compute(lead.id);
  const manual = await knex('leads').where({ id: lead.id }).first();
  assert.equal(manual.temperature, 'cold'); assert.equal(manual.score, 65, 'score keeps updating underneath');
  await ad.post(`/staff/leads/${lead.id}/temperature`).type('form').send({ _csrf: t, temperature: 'auto' });
  assert.equal((await knex('leads').where({ id: lead.id }).first()).temperature, 'hot');
  const c = await staffAgent(counsellor);
  assert.equal((await c.get('/staff/settings/scoring')).status, 403);
});

test('campaigns reach only consenting people, track opens/clicks safely and honour unsubscribe everywhere', async () => {
  const leads = require('../src/modules/crm/leads.service');
  const mk = async (email, marketingOk, countries = ['uk']) => (await leads.capture({ userId: null }, { first_name: email.split('@')[0], email, interest_countries: countries }, { source: 'contact_form', consent: { contact: true, marketing: marketingOk } }, {})).lead;
  const yes = await mk('yes@example.com', true);
  await mk('no@example.com', false);
  await mk('canada@example.com', true, ['canada']);
  const m = await staffAgent(marketing);
  const t = await m.token();
  const r = await m.post('/staff/campaigns').type('form').send({ _csrf: t, name: 'UK September intake', channel: 'email', audience: 'leads', countries: 'uk', subject_en: 'Study in the UK, {{first_name}}', body_en: 'Hello {{student_name}}, applications are open.', cta_en: 'See programs', cta_url: '/programs?country=uk' });
  assert.equal(r.status, 302);
  const id = Number(r.headers.location.split('/').pop());
  const page = await m.get(`/staff/campaigns/${id}`);
  assert.match(page.text, /1 people will receive this/);
  await m.post(`/staff/campaigns/${id}/launch`).type('form').send({ _csrf: t });
  const recips = await knex('campaign_recipients').where({ campaign_id: id });
  assert.deepEqual(recips.map((x) => x.address), ['yes@example.com']);
  outbox.length = 0;
  await require('../src/modules/growth/campaigns.service').tick();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].subject, 'Study in the UK, yes');
  assert.match(outbox[0].headers['List-Unsubscribe'], /\/u\//);
  assert.match(outbox[0].html, /\/c\/o\/[A-Za-z0-9_-]+\.gif/);
  assert.equal((await knex('campaigns').where({ id }).first()).status, 'sent');
  assert.ok(await knex('messages').where({ lead_id: yes.id, template_key: knex.raw('template_key') }).first(), 'logged on the timeline');
  const token = recips[0].token;
  const a = await agent();
  await a.get(`/c/o/${token}.gif`);
  const click = await a.get(`/c/c/${token}?u=https://evil.example`);
  assert.equal(click.status, 302);
  assert.match(click.headers.location, /\/programs\?country=uk&utm_source=gec&utm_medium=email&utm_campaign=uk-september-intake/);
  const st = await require('../src/modules/growth/campaigns.service').stats(id);
  assert.equal(st.opened, 1); assert.equal(st.clicked, 1);
  // one-click unsubscribe (no session, no CSRF token)
  const u = await a.post(`/u/${token}`).type('form').send('List-Unsubscribe=One-Click');
  assert.equal(u.status, 200);
  const after = await knex('leads').where({ id: yes.id }).first();
  assert.equal(after.consent_marketing, 0); assert.ok(after.unsubscribed_at);
  const c2 = await m.post('/staff/campaigns').type('form').send({ _csrf: t, name: 'Again', channel: 'email', audience: 'leads', countries: 'uk', subject_en: 'x', body_en: 'y' });
  const id2 = Number(c2.headers.location.split('/').pop());
  await m.post(`/staff/campaigns/${id2}/launch`).type('form').send({ _csrf: t });
  assert.equal((await knex('campaign_recipients').where({ campaign_id: id2 })).length, 0, 'unsubscribed people are never included again');
  const c = await staffAgent(counsellor);
  assert.equal((await c.get('/staff/campaigns')).status, 403);
});

test('automations: off until enabled, conditions decide, actions run once and are logged', async () => {
  const ad = await staffAgent(admin);
  const t = await ad.token();
  const r = await ad.post('/staff/automations').type('form').send({ _csrf: t, name: 'UK leads → call task', trigger: 'lead.created', delay_hours: '', c_field: 'country', c_op: 'eq', c_value: 'uk',
    a_type: ['create_task', 'add_note', 'send_template'], a_title: ['Call new UK lead', '', ''], a_due_hours: ['2', '', ''], a_assign: ['counsellor', 'counsellor', 'counsellor'], a_text: ['', 'UK pathway', ''], a_template: ['', '', 'welcome'], a_channel: ['email', 'email', 'email'], a_priority: ['high', 'normal', 'normal'], a_stage_key: ['', '', ''], a_employee_id: ['', '', ''] });
  assert.equal(r.status, 302);
  const rule = await knex('automations').first();
  assert.equal(rule.is_active, 0, 'new rules start switched off');
  const leads = require('../src/modules/crm/leads.service');
  const before = await leads.capture({ userId: null }, { first_name: 'Off', email: 'off@example.com', interest_countries: ['uk'] }, { source: 'contact_form' }, {});
  assert.equal(await knex('tasks').where({ lead_id: before.lead.id, origin: `automation:${rule.id}` }).first(), undefined);
  await ad.post(`/staff/automations/${rule.id}/toggle`).type('form').send({ _csrf: t });
  outbox.length = 0;
  const uk = await leads.capture({ userId: null }, { first_name: 'Yara', email: 'yara@example.com', interest_countries: ['uk'] }, { source: 'contact_form' }, {});
  const ca = await leads.capture({ userId: null }, { first_name: 'Sam', email: 'sam@example.com', interest_countries: ['canada'] }, { source: 'contact_form' }, {});
  const task = await knex('tasks').where({ lead_id: uk.lead.id, origin: `automation:${rule.id}` }).first();
  assert.ok(task); assert.equal(task.priority, 'high'); assert.equal(task.title, 'Call new UK lead');
  assert.ok(await knex('activities').where({ lead_id: uk.lead.id, title: 'automation_note' }).first());
  assert.ok(outbox.some((x) => x.to === 'yara@example.com'), 'welcome sent');
  assert.equal(await knex('tasks').where({ lead_id: ca.lead.id, origin: `automation:${rule.id}` }).first(), undefined, 'condition not met');
  assert.equal((await knex('automation_runs').where({ automation_id: rule.id })).length, 1);
  // time-based rule fires once per record
  const automations = require('../src/modules/growth/automations.service');
  const [tid] = await knex('automations').insert({ name: 'Not contacted', trigger: 'lead.not_contacted', delay_hours: 0, is_active: true, conditions: '[]', actions: JSON.stringify([{ type: 'create_task', title: 'Overdue first contact', due_hours: 1, assign: 'counsellor' }]) });
  await automations.timed();
  await automations.timed();
  const overdue = await knex('tasks').where({ origin: `automation:${tid}` });
  assert.equal(overdue.length, new Set(overdue.map((x) => x.lead_id)).size, 'once per lead');
  assert.ok(overdue.length >= 3);
  const c = await staffAgent(counsellor);
  assert.equal((await c.get('/staff/automations')).status, 403);
});

test('analytics: funnel and sources for the period; team performance needs reports.team', async () => {
  const ad = await staffAgent(admin);
  const page = await ad.get('/staff/analytics?days=30');
  assert.equal(page.status, 200);
  const analytics = require('../src/modules/growth/analytics.service');
  const today = new Date().toISOString().slice(0, 10);
  const o = await analytics.overview({ employee: { dataScope: 'all' } }, { from: today, to: today });
  const leadsCount = Number((await knex('leads').whereNot('status', 'merged').count({ n: '*' }))[0].n);
  assert.equal(o.funnel[0][1], leadsCount);
  const src = await analytics.sources({ employee: { dataScope: 'all' } }, { from: today, to: today });
  assert.ok(src.find((s) => s.source === 'contact_form'));
  const csv = await ad.get('/staff/analytics?days=30&format=csv');
  assert.match(csv.text, /contact_form/);
  assert.equal((await ad.get('/staff/analytics/team')).status, 200);
  const c = await staffAgent(counsellor);
  assert.equal((await c.get('/staff/analytics/team')).status, 403);
  assert.equal((await c.get('/staff/analytics')).status, 403);
});
