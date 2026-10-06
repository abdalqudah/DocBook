// End-to-end journey (phase 10): one person from an anonymous search to enrolment, through every module, using
// the same HTTP routes the website, the student portal and the staff workspace use.
const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent, agent, outbox } = require('./helpers');

const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const stageKey = async (table, id) => (await knex(table).where({ id }).first('key')).key;
const appStage = async (key) => (await knex('application_stages').where({ key }).first()).id;

let manager; let counsellor; let admissions; let visaOfficer; let finance;
test.before(async () => {
  await resetDb();
  await require('../src/db/seeds/demo-catalog').run();
  manager = await makeStaff({ role: 'branch_manager', name: 'Huda Manager' });
  counsellor = await makeStaff({ role: 'counsellor', name: 'Sami Counsellor' });
  admissions = await makeStaff({ role: 'admissions_manager', name: 'Adam Admissions' });
  visaOfficer = await makeStaff({ role: 'visa_officer', name: 'Vera Visa' });
  finance = await makeStaff({ role: 'finance', name: 'Fadi Finance' });
  const [typeId] = await knex('appointment_types').insert({ slug: 'free-consultation', name_en: 'Free consultation', name_ar: 'استشارة مجانية', duration_min: 30, buffer_min: 10, location_mode: 'online', min_notice_hours: 2, max_days_ahead: 30 });
  await knex('appointment_type_staff').insert({ type_id: typeId, employee_id: counsellor.employee.id });
  const rows = [];
  for (let wd = 0; wd < 7; wd += 1) rows.push({ employee_id: counsellor.employee.id, weekday: wd, start_time: '00:00', end_time: '23:30' });
  await knex('availability').insert(rows);
});
test.after(() => knex.destroy());

test('journey: search → university → costs → booking → lead → student → application → offer → visa → payment → enrolled', async () => {
  // ---------------------------------------------------------------- 1. Anonymous visitor (accepted analytics cookies)
  const v = await agent();
  v.h = (r) => r.set('User-Agent', 'Mozilla/5.0 (Macintosh)').set('Cookie', [`gec_consent=all`, ...(v.vid ? [`gec_vid=${v.vid}`] : [])].join('; '));
  v.visit = async (path) => { const r = await v.h(v.get(path)); const m = /gec_vid=([^;]+)/.exec((r.headers['set-cookie'] || []).join(';')); if (m) v.vid = m[1]; return r; };

  const search = await v.visit(`/programs?q=${encodeURIComponent("Master's in Data Science")}&degree=master`);
  assert.equal(search.status, 200);
  assert.match(search.text, /MSc Data Science/, 'search finds the program');
  assert.match(search.text, /The University of Manchester/);
  const program = await knex('programs as p').join('universities as u', 'u.id', 'p.university_id').where('u.slug', 'university-of-manchester-demo').where('p.field', 'data_science').first('p.*');
  assert.ok(program);
  assert.equal((await v.visit(`/programs/${program.slug}`)).status, 200);
  const uni = await v.visit('/universities/university-of-manchester-demo');
  assert.equal(uni.status, 200); assert.match(uni.text, /MSc Data Science/);
  const calc = await v.visit('/cost-calculator?d=uk&housing=shared&years=1');
  assert.equal(calc.status, 200); assert.match(calc.text, /United Kingdom/);
  assert.ok(v.vid, 'first-party visitor id after consent');

  // ---------------------------------------------------------------- 2. Books a free consultation → lead with history
  outbox.length = 0;
  const sched = await v.visit('/book/schedule/free-consultation');
  const slot = /confirm\?start=([^&"]+)&(?:amp;)?with=(\d+)/.exec(sched.text);
  assert.ok(slot, 'free slots offered');
  const confirm = await v.visit(`/book/schedule/free-consultation/confirm?start=${slot[1]}&with=${slot[2]}`);
  const booked = await v.h(v.post('/book/schedule/free-consultation/confirm')).type('form').send({ _csrf: csrfOf(confirm.text), start: decodeURIComponent(slot[1]), with: slot[2], first_name: 'Layla', last_name: 'Nasser', email: 'layla@example.com', phone: '+962791234567', notes: "Master's in Data Science in the UK", consent_contact: '1' });
  assert.equal(booked.status, 302);
  const lead = await knex('leads').where({ email: 'layla@example.com' }).first();
  assert.ok(lead, 'lead created');
  assert.equal(lead.source, 'consultation');
  assert.equal(await stageKey('lead_stages', lead.stage_id), 'counselling_booked');
  assert.ok(await knex('appointments').where({ lead_id: lead.id, employee_id: counsellor.employee.id }).first(), 'appointment with the counsellor');
  const visitor = await knex('visitors').where({ id: v.vid }).first();
  assert.equal(visitor.lead_id, lead.id, 'the website visit is linked to the lead');
  const history = await knex('tracking_events').where({ visitor_id: v.vid }).pluck('path');
  assert.ok(history.some((p) => p.startsWith('/programs')) && history.some((p) => p.startsWith('/universities/')) && history.some((p) => p.startsWith('/cost-calculator')), `browsing history kept: ${history.join(', ')}`);
  assert.ok(outbox.some((m) => m.to === 'layla@example.com'), 'booking confirmation e-mailed');

  // ---------------------------------------------------------------- 3. Assigned and contacted
  const m = await staffAgent(manager);
  let tok = await m.token();
  await m.post(`/staff/leads/${lead.id}/assign`).type('form').send({ _csrf: tok, counsellor_id: String(counsellor.employee.id) });
  assert.equal((await knex('leads').where({ id: lead.id }).first()).counsellor_id, counsellor.employee.id, 'assigned');
  const c = await staffAgent(counsellor);
  tok = await c.token();
  const leadPage = await c.get(`/staff/leads/${lead.id}`);
  assert.equal(leadPage.status, 200); assert.match(leadPage.text, /Layla/);
  await c.post(`/staff/leads/${lead.id}/contact`).type('form').send({ _csrf: tok, channel: 'call', outcome: 'reached', body: 'Discussed UK data science programs and budget.' });
  assert.ok(await knex('activities').where({ lead_id: lead.id, type: 'call' }).first() || await knex('activities').where({ lead_id: lead.id }).where('title', 'like', '%contact%').first(), 'contact logged on the timeline');

  // ---------------------------------------------------------------- 4. Student record and portal account
  const conv = await c.post(`/staff/leads/${lead.id}/convert`).type('form').send({ _csrf: tok });
  assert.equal(conv.status, 302);
  const student = await knex('students').where({ email: 'layla@example.com' }).first();
  assert.ok(student, 'student created from the lead');
  assert.equal(student.counsellor_id, counsellor.employee.id);
  assert.equal((await knex('leads').where({ id: lead.id }).first()).student_id, student.id);
  outbox.length = 0;
  await c.post(`/staff/students/${student.id}/invite`).type('form').send({ _csrf: tok });
  const invite = outbox.find((x) => x.to === 'layla@example.com');
  assert.ok(invite, 'portal invitation e-mailed');
  const link = /http:\/\/[^"\s]+(\/reset\/[A-Za-z0-9_-]+)/.exec(invite.html || invite.text)[1];
  const s = await agent();
  const setPw = await s.get(link);
  await s.post(link).type('form').send({ _csrf: csrfOf(setPw.text), password: 'LaylaPass123!', password_confirm: 'LaylaPass123!' });
  const loginPage = await s.get('/login');
  const signedIn = await s.post('/login').type('form').send({ _csrf: csrfOf(loginPage.text), email: 'layla@example.com', password: 'LaylaPass123!' });
  assert.equal(signedIn.headers.location, '/portal');

  // ---------------------------------------------------------------- 5. Completes the profile
  const step = async (name, data) => { const p = await s.get(`/portal/profile/${name}`); const r = await s.post(`/portal/profile/${name}`).type('form').send({ _csrf: csrfOf(p.text), ...data }); assert.equal(r.status, 302, `profile step ${name}`); };
  await step('personal', { first_name: 'Layla', last_name: 'Nasser', phone: '+962791234567', nationality: 'JO', residence_country: 'JO', date_of_birth: '2001-04-12', passport: 'N1234567', passport_expiry: '2031-01-01' });
  await step('academic', { education_level: 'bachelor', institution: 'University of Jordan', major: 'Computer Science', gpa: '85', gpa_scale: '100', graduation_date: '2024-06-30' });
  await step('english', { ielts_overall: '7', ielts_min_band: '6.5' });
  await step('goals', { pref_countries: 'uk', pref_fields: 'data_science', pref_degree: 'master', budget_usd: '45000', pref_intake: '2027-09' });
  const prof = await knex('students').where({ id: student.id }).first();
  assert.equal(Number(prof.ielts_overall), 7); assert.equal(prof.pref_degree, 'master');

  // ---------------------------------------------------------------- 6. Recommendations and shortlist
  const recs = await s.get('/portal/programs');
  assert.equal(recs.status, 200);
  assert.match(recs.text, /MSc Data Science/, 'the program is recommended');
  assert.match(recs.text, /not a prediction or a guarantee/, 'recommendations say they are guidance, not a promise');
  assert.match(recs.text, /match-reasons|reason/i, 'each recommendation explains why');
  await s.post('/shortlist/toggle').type('form').send({ _csrf: csrfOf(recs.text), type: 'program', id: program.id });
  assert.ok(await knex('shortlist_items').where({ student_id: student.id, item_type: 'program', item_id: program.id }).first(), 'shortlisted');

  // ---------------------------------------------------------------- 7. Application and documents
  tok = await c.token();
  const appRes = await c.post('/staff/applications').type('form').send({ _csrf: tok, student_id: student.id, program_id: program.id, intake: '2027-09', stage_key: 'documents_pending' });
  assert.equal(appRes.status, 302);
  const app = await knex('applications').where({ student_id: student.id, program_id: program.id }).first();
  assert.ok(app);
  const docs = await knex('documents').where({ student_id: student.id }).whereIn('status', ['missing', 'requested']);
  assert.ok(docs.length >= 3, 'document checklist created');
  for (const d of docs) {
    const page = await s.get('/portal/documents'); // eslint-disable-line no-await-in-loop
    const up = await s.post('/portal/documents/upload').field('_csrf', csrfOf(page.text)).field('document_id', String(d.id)).attach('file', pdf, `${d.type_key}.pdf`); // eslint-disable-line no-await-in-loop
    assert.equal(up.status, 302, `upload ${d.type_key}`);
  }
  assert.equal(Number((await knex('documents').where({ student_id: student.id, status: 'uploaded' }).count({ n: '*' }))[0].n), docs.length, 'all uploaded by the student');
  const am = await staffAgent(admissions);
  const at = await am.token();
  for (const d of docs) await am.post(`/staff/documents/${d.id}/review`).type('form').send({ _csrf: at, decision: 'approve', expiry_date: d.type_key === 'passport' ? '2031-01-01' : '' }); // eslint-disable-line no-await-in-loop
  assert.equal(Number((await knex('documents').where({ student_id: student.id, status: 'approved' }).count({ n: '*' }))[0].n), docs.length, 'all verified');
  assert.equal(await stageKey('application_stages', (await knex('applications').where({ id: app.id }).first()).stage_id), 'documents_complete');

  // ---------------------------------------------------------------- 8. Submitted, offer
  await am.post(`/staff/applications/${app.id}/stage`).type('form').send({ _csrf: at, stage_id: await appStage('submitted') });
  await am.post(`/staff/applications/${app.id}/stage`).type('form').send({ _csrf: at, stage_id: await appStage('unconditional_offer'), note: 'Offer letter received' });
  assert.equal(await stageKey('application_stages', (await knex('applications').where({ id: app.id }).first()).stage_id), 'unconditional_offer');
  assert.equal((await knex('students').where({ id: student.id }).first()).journey_stage, 'offer');
  const portalApp = await s.get(`/portal/applications/${app.id}`);
  assert.equal(portalApp.status, 200); assert.match(portalApp.text, /Unconditional Offer/, 'student sees the offer');
  assert.ok(await knex('notifications').where({ user_id: (await knex('users').where({ email: 'layla@example.com' }).first()).id }).first(), 'student notified in the portal');

  // ---------------------------------------------------------------- 9. Visa case
  const vo = await staffAgent(visaOfficer);
  const vt = await vo.token();
  await vo.post(`/staff/students/${student.id}/visa`).type('form').send({ _csrf: vt, country_code: 'GB', visa_type: 'Student visa', application_id: String(app.id) });
  const vc = await knex('visa_cases').where({ student_id: student.id }).first();
  assert.ok(vc, 'visa case opened');
  await vo.post(`/staff/visa/${vc.id}/stage`).type('form').send({ _csrf: vt, stage: 'submitted' });
  await vo.post(`/staff/visa/${vc.id}/stage`).type('form').send({ _csrf: vt, stage: 'approved' });
  assert.equal((await knex('visa_cases').where({ id: vc.id }).first()).stage, 'approved');
  assert.equal((await knex('students').where({ id: student.id }).first()).journey_stage, 'pre_departure');

  // ---------------------------------------------------------------- 10. Invoice and payment
  const f = await staffAgent(finance);
  const ft = await f.token();
  await f.post('/staff/invoices').type('form').send({ _csrf: ft, student_id: student.id, currency: 'USD', locale: 'en', item_description: ['Application and visa service'], item_quantity: ['1'], item_unit_price: ['900'] });
  const inv = await knex('invoices').where({ student_id: student.id }).first();
  assert.ok(inv);
  await f.post(`/staff/invoices/${inv.id}/issue`).type('form').send({ _csrf: ft });
  await f.post(`/staff/invoices/${inv.id}/payments`).type('form').send({ _csrf: ft, amount: '900', method: 'bank_transfer', reference: 'TRX-LAYLA' });
  assert.equal((await knex('invoices').where({ id: inv.id }).first()).status, 'paid');
  const pay = await s.get('/portal/payments');
  assert.match(pay.text, new RegExp(inv.number), 'student sees the paid invoice');

  // ---------------------------------------------------------------- 11. Pre-departure task, enrolment
  tok = await c.token();
  await c.post(`/staff/students/${student.id}/tasks`).type('form').send({ _csrf: tok, title: 'Pre-departure briefing and arrival checklist', priority: 'normal', due_at: '2027-08-15' });
  const task = await knex('tasks').where({ student_id: student.id }).where('title', 'like', 'Pre-departure%').first();
  assert.ok(task, 'pre-departure task created');
  await c.post(`/staff/tasks/${task.id}/status`).type('form').send({ _csrf: tok, status: 'completed' });
  assert.equal((await knex('tasks').where({ id: task.id }).first()).status, 'completed');
  await am.post(`/staff/applications/${app.id}/stage`).type('form').send({ _csrf: at, stage_id: await appStage('pre_departure') });
  await am.post(`/staff/applications/${app.id}/stage`).type('form').send({ _csrf: at, stage_id: await appStage('enrolled') });
  const final = await knex('students').where({ id: student.id }).first();
  assert.equal(final.journey_stage, 'enrolled');
  assert.equal(final.status, 'enrolled');

  // ---------------------------------------------------------------- 12. One connected record
  const timeline = await knex('activities').where((w) => w.where({ student_id: student.id }).orWhere({ lead_id: lead.id })).pluck('type');
  for (const t of ['stage']) assert.ok(timeline.includes(t), `timeline has ${t}`);
  assert.ok(timeline.length >= 10, `one timeline across modules (${timeline.length} entries)`);
  const staffView = await c.get(`/staff/students/${student.id}`);
  assert.equal(staffView.status, 200); assert.match(staffView.text, /Layla/);
  const home = await s.get('/portal');
  assert.equal(home.status, 200);
  assert.ok(await knex('audit_logs').where({ entity_type: 'student', entity_id: student.id }).first(), 'audited');
  // The counsellor's scope: another counsellor cannot open this student
  const other = await staffAgent(await makeStaff({ role: 'counsellor', name: 'Other Counsellor' }));
  assert.equal((await other.get(`/staff/students/${student.id}`)).status, 404);
});
