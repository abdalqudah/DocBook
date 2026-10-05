const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, agent, staffAgent, outbox } = require('./helpers');

test.before(async () => {
  await resetDb();
  await require('../src/db/seeds/demo-catalog').run();
});
test.after(() => knex.destroy());

test('finder understands "Master\'s in Data Science UK" and filters on the server', async () => {
  const finder = require('../src/modules/catalog/finder.service');
  const parsed = await finder.parseQuery("Master's in Data Science UK");
  assert.equal(parsed.degree, 'master');
  assert.equal(parsed.field, 'data_science');
  assert.equal(parsed.destination, 'uk');
  const r = await finder.search({ q: "Master's in Data Science UK" });
  assert.ok(r.total >= 1);
  assert.ok(r.rows.every((p) => p.degree_level === 'master' && p.field === 'data_science' && p.destination_slug === 'uk'));
  const ar = await finder.parseQuery('ماجستير علم البيانات في بريطانيا');
  assert.deepEqual([ar.degree, ar.field, ar.destination], ['master', 'data_science', 'uk']);
  const ielts = await finder.search({ ielts: '6' });
  assert.ok(ielts.rows.every((p) => p.min_ielts === null || Number(p.min_ielts) <= 6));
  const cheap = await finder.search({ max_tuition: '20000' });
  assert.ok(cheap.rows.every((p) => p.tuition_usd === null || p.tuition_usd <= 20000));
  const junk = await finder.search({ degree: "master' OR 1=1 --", sort: 'DROP TABLE', page: '-5' });
  assert.equal(junk.filters.degree.length, 0);
  assert.equal(junk.filters.page, 1);
});

test('public pages: program has structured data; internal partner notes never appear', async () => {
  const a = await agent();
  const p = await knex('programs').where('slug', 'like', 'msc-data-science-university-of-manchester%').first();
  const page = await a.get(`/programs/${p.slug}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /application\/ld\+json/);
  assert.match(page.text, /"@type":"Course"/);
  assert.match(page.text, /<link rel="canonical"/);
  const u = await knex('universities').where({ slug: 'illinois-tech' }).first();
  await knex('universities').where({ id: u.id }).update({ commission_note: 'SECRET-COMMISSION-15', internal_notes: 'SECRET-INTERNAL-NOTE' });
  for (const path of ['/universities/illinois-tech', '/universities', '/programs?university=' + u.id, '/search?q=illinois', '/api/suggest?q=illinois']) {
    const r = await a.get(path); // eslint-disable-line no-await-in-loop
    assert.doesNotMatch(r.text, /SECRET-/, path);
  }
  assert.equal((await a.get('/programs/does-not-exist')).status, 404);
});

test('shortlist and compare work for anonymous visitors and move to the student on sign-in', async () => {
  const a = await agent();
  const home = await a.get('/programs');
  const token = /name="_csrf" value="([^"]+)"/.exec(home.text)[1];
  const [p1, p2] = await knex('programs').orderBy('id').limit(2);
  const r = await a.post('/shortlist/toggle').set('Accept', 'application/json').set('X-CSRF-Token', token).type('form').send({ type: 'program', id: p1.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.on, true);
  const list = await a.get('/shortlist');
  assert.match(list.text, new RegExp(p1.name_en.replace(/[()]/g, '.')));
  // compare
  await a.post('/compare/toggle').set('Accept', 'application/json').set('X-CSRF-Token', token).type('form').send({ id: p1.id });
  const c2 = await a.post('/compare/toggle').set('Accept', 'application/json').set('X-CSRF-Token', token).type('form').send({ id: p2.id });
  assert.deepEqual(c2.body.ids, [p1.id, p2.id]);
  const saved = await a.post('/compare/save').type('form').send({ _csrf: token });
  assert.equal(saved.status, 302);
  const link = saved.headers.location;
  assert.match(link, /^\/compare\/[A-Za-z0-9]+$/);
  const shared = await (await agent()).get(link);
  assert.equal(shared.status, 200);
  assert.match(shared.text, /compare-table/);
  // adopt into a student after sign-in
  const shortlist = require('../src/modules/catalog/shortlist.service');
  const row = await knex('shortlist_items').whereNotNull('visitor_key').first();
  const [sid] = await knex('students').insert({ ref: 'S-TEST01', first_name: 'Test' });
  await shortlist.adopt(row.visitor_key, sid);
  assert.equal((await knex('shortlist_items').where({ student_id: sid })).length, 1);
  assert.equal((await knex('shortlist_items').where({ visitor_key: row.visitor_key })).length, 0);
});

test('matching: categories and reasons follow published requirements, never guesses', async () => {
  const m = require('../src/modules/catalog/matching.service');
  const finder = require('../src/modules/catalog/finder.service');
  const [p] = await finder.programsByIds([(await knex('programs').where('slug', 'like', 'msc-data-science-university-of-manchester%').first()).id]);
  const strong = await m.evaluate({ gpa: 85, ielts: 7, ieltsBand: 6.5, toefl: null, pte: null, duolingo: null, budget: 80000, degree: 'master', fields: ['data_science'], countries: ['uk'], intake: 9, wantsWork: true }, p);
  assert.equal(strong.category, 'excellent');
  assert.ok(strong.reasons.some((r) => r.key === 'english_meets'));
  const lowEnglish = await m.evaluate({ gpa: 85, ielts: 5, ieltsBand: 5, budget: 80000, fields: [], countries: [], intake: null, wantsWork: false, toefl: null, pte: null, duolingo: null }, p);
  assert.equal(lowEnglish.category, 'not_eligible');
  const unknown = await m.evaluate({ gpa: null, ielts: null, budget: null, fields: [], countries: [], intake: null, wantsWork: false, toefl: null, pte: null, duolingo: null }, p);
  assert.equal(unknown.category, 'missing');
  const noData = await m.evaluate({ gpa: 85, ielts: 7, budget: 10000, fields: [], countries: [], intake: null, wantsWork: false, toefl: null, pte: null, duolingo: null }, { ...p, min_gpa_pct: null, min_ielts: null, min_toefl: null, min_pte: null, min_duolingo: null });
  assert.ok(noData.reasons.some((r) => r.key === 'gpa_unpublished') && noData.reasons.some((r) => r.key === 'english_unpublished'));
  assert.equal(m.gpaPct(3, 4), 75);
});

test('catalogue admin: RBAC, normalised tuition, CSV export hides internal columns, CSV import upserts', async () => {
  const counsellor = await staffAgent(await makeStaff({ role: 'counsellor' }));
  assert.equal((await counsellor.get('/staff/programs')).status, 200, 'counsellors can browse');
  const ct = await counsellor.token();
  const uni = await knex('universities').where({ slug: 'university-of-manchester-demo' }).first();
  assert.equal((await counsellor.post('/staff/programs').type('form').send({ _csrf: ct, name_en: 'X', university_id: uni.id, degree_level: 'master', field: 'business', currency: 'GBP', study_mode: 'on_campus', internship: 'none' })).status, 403);

  const am = await staffAgent(await makeStaff({ role: 'admissions_manager' }));
  const t = await am.token();
  const r = await am.post('/staff/programs').type('form').send({ _csrf: t, name_en: 'MSc Finance Test', university_id: uni.id, degree_level: 'master', field: 'finance', currency: 'GBP', tuition_fee: '7900', study_mode: 'on_campus', internship: 'none', intakes: ['9', '1'], is_active: '1' });
  assert.equal(r.status, 302);
  const created = await knex('programs').where({ name_en: 'MSc Finance Test' }).first();
  assert.equal(created.slug, 'msc-finance-test');
  assert.equal(created.tuition_usd, 10000);
  assert.deepEqual(Array.isArray(created.intakes) ? created.intakes : JSON.parse(created.intakes), [9, 1]);
  assert.ok(await knex('audit_logs').where({ action: 'program.created', entity_id: String(created.id) }).first());

  const fin = await staffAgent(await makeStaff({ role: 'marketing' }));
  const csv = await fin.get('/staff/universities/export.csv');
  assert.equal(csv.status, 200);
  assert.doesNotMatch(csv.text.split('\n')[0], /commission_note|internal_notes/, 'no internal columns without catalog.internal');
  const csvAm = await am.get('/staff/universities/export.csv');
  assert.match(csvAm.text.split('\n')[0], /commission_note/);

  const body = 'slug,name_en,university,degree_level,field,currency,tuition_fee,intakes,study_mode,internship,is_active\n'
    + 'msc-finance-test,MSc Finance (updated),university-of-manchester-demo,master,finance,GBP,8000,9,on_campus,none,1\n'
    + 'new-csv-program,BSc New Program,university-of-manchester-demo,bachelor,business,GBP,20000,9 1,on_campus,optional,1\n'
    + 'bad-row,,,nonsense,finance,GBP,1,,on_campus,none,1\n';
  const imp = await am.post(`/staff/programs/import?_csrf=${encodeURIComponent(t)}`).field('_csrf', t).attach('file', Buffer.from(body), 'programs.csv');
  assert.equal(imp.status, 302);
  assert.equal((await knex('programs').where({ slug: 'msc-finance-test' }).first()).name_en, 'MSc Finance (updated)');
  const nw = await knex('programs').where({ slug: 'new-csv-program' }).first();
  assert.ok(nw);
  assert.equal(nw.tuition_usd, Math.round(20000 / 0.79));
  assert.equal(await knex('programs').where({ slug: 'bad-row' }).first(), undefined);
});

test('cost calculator converts currencies; a counsellor sends a personal estimate', async () => {
  const calc = require('../src/modules/catalog/calculator');
  const r = await calc.calculate({ destinations: ['uk', 'usa'], currency: 'USD', housing: 'shared', scholarship: 5000, years: 2 });
  assert.equal(r.rows.length, 2);
  assert.ok(r.rows[0].items.tuition > 0);
  assert.equal(r.rows[1].scholarship, 5000);
  assert.equal(r.rows[1].total, (r.rows[1].gross - 5000) * 2);

  const c = await makeStaff({ role: 'counsellor' });
  const [sid] = await knex('students').insert({ ref: 'S-EST001', first_name: 'Nadia', email: 'nadia@example.com', counsellor_id: c.employee.id });
  const a = await staffAgent(c);
  const t = await a.token();
  outbox.length = 0;
  const res = await a.post(`/staff/students/${sid}/estimates`).type('form').send({ _csrf: t, d: ['uk', 'canada'], currency: 'JOD', housing: 'campus', years: '1', send: '1' });
  assert.equal(res.status, 302);
  const est = await knex('cost_estimates').where({ student_id: sid }).first();
  assert.ok(est && est.sent_at);
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].html, new RegExp(`/estimate/${est.token}`));
  const view = await (await agent()).get(`/estimate/${est.token}`);
  assert.equal(view.status, 200);
  assert.match(view.text, /JOD/);
});
