// Demo CRM data for development and training: counsellors, leads in every stage, students, tasks.
// Every row is flagged is_demo = 1 and shows a "Demo" chip; `npm run seed -- --remove` deletes them all.
const knex = require('../knex');
const { hashPassword } = require('../../modules/auth/auth.service');
const leads = require('../../modules/crm/leads.service');
const students = require('../../modules/crm/students.service');
const tasks = require('../../modules/crm/tasks.service');
const stages = require('../../modules/crm/stages');

const COUNSELLORS = [
  ['Sarah Haddad', 'sarah.demo@gec.test', ['usa', 'canada']],
  ['Omar Khalil', 'omar.demo@gec.test', ['uk', 'ireland', 'germany']],
  ['Lina Mansour', 'lina.demo@gec.test', ['australia', 'usa']],
];
const PEOPLE = [
  ['Ahmad', 'Al-Masri', 'JO', 'master', 'Data Science', ['uk'], '20_35', 'consultation', 'google'],
  ['Layla', 'Hassan', 'SA', 'bachelor', 'Computer Science', ['usa'], '35_50', 'program_inquiry', 'instagram'],
  ['Yousef', 'Nasser', 'AE', 'master', 'Business Analytics', ['canada', 'usa'], '20_35', 'whatsapp', null],
  ['Mariam', 'Saleh', 'KW', 'phd', 'Artificial Intelligence', ['germany'], '10_20', 'scholarship_inquiry', 'facebook'],
  ['Khaled', 'Abdullah', 'QA', 'bachelor', 'Engineering', ['australia'], 'gt50', 'event', null],
  ['Noor', 'Ibrahim', 'JO', 'foundation', 'Business & Management', ['uk', 'ireland'], '10_20', 'contact_form', 'google'],
  ['Hamza', 'Odeh', 'PS', 'master', 'Cybersecurity', ['usa'], '20_35', 'consultation', 'tiktok'],
  ['Rania', 'Fares', 'LB', 'language', 'English Language', ['uk'], 'lt10', 'course_inquiry', null],
  ['Tariq', 'Zayed', 'OM', 'master', 'Finance & Accounting', ['canada'], '35_50', 'referral', null],
  ['Huda', 'Qasem', 'BH', 'bachelor', 'Nursing', ['ireland'], '20_35', 'consultation', 'google'],
];

async function run() {
  const role = await knex('roles').where({ key: 'counsellor' }).first();
  const branch = await knex('branches').orderBy('id').first();
  const empIds = [];
  for (const [name, email, countries] of COUNSELLORS) {
    let u = await knex('users').where({ kind: 'staff', email }).first();
    if (!u) {
      const [uid] = await knex('users').insert({ kind: 'staff', email, name, password_hash: await hashPassword('Password123'), status: 'active' });
      await knex('employees').insert({ user_id: uid, role_id: role.id, branch_id: branch.id, job_title: 'Senior Counsellor', is_counsellor: true, auto_assign: true, countries: JSON.stringify(countries), is_demo: true });
      u = { id: uid };
    }
    empIds.push((await knex('employees').where({ user_id: u.id }).first('id')).id);
  }
  if (await knex('leads').where({ is_demo: true }).first('id')) return { skipped: true };
  const all = (await stages.all()).filter((s) => !s.is_lost);
  const ctx = { userId: null };
  for (let i = 0; i < PEOPLE.length; i += 1) {
    const [first, last, cc, degree, field, countries, budget, source, utm] = PEOPLE[i];
    const { lead } = await leads.capture(ctx, {
      first_name: first, last_name: last, email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}@example.com`, phone: `+9627${String(90000000 + i * 1234567).slice(0, 8)}`,
      nationality: cc, residence_country: cc, interest_degree: degree, interest_field: field, interest_countries: countries, budget_range: budget,
      interest_intake: '2027-09', education_level: degree === 'master' || degree === 'phd' ? 'bachelor' : 'high_school', message: 'Demo enquiry', is_demo: true,
    }, { source, utm: utm ? { source: utm, medium: utm === 'google' ? 'cpc' : 'social', campaign: 'demo-autumn' } : {}, consent: { contact: true, marketing: i % 2 === 0 } });
    const stage = all[i % Math.min(all.length, 8)];
    if (stage.id !== lead.stage_id) await knex('leads').where({ id: lead.id }).update({ stage_id: stage.id, first_contacted_at: i % 8 > 1 ? new Date() : null });
    await knex('leads').where({ id: lead.id }).update({ score: [5, 15, 30, 45, 60, 25, 70, 10, 35, 50][i], temperature: ['cold', 'cold', 'warm', 'warm', 'hot', 'warm', 'hot', 'cold', 'warm', 'hot'][i], counsellor_id: empIds[i % empIds.length] });
    if (i >= 6) {
      const staff = { employee: { dataScope: 'all' }, permissions: new Set() };
      const s = await students.convertLead(ctx, staff, lead.id);
      await knex('students').where({ id: s.id }).update({ is_demo: true, gpa: 3.2 + (i % 3) * 0.2, gpa_scale: 4, ielts_overall: 6.5, budget_usd: 30000, date_of_birth: '2001-05-14', major: field, education_level: 'bachelor' });
    }
    await tasks.create(ctx, { title: `Follow up with ${first}`, lead_id: lead.id, assignee_id: empIds[i % empIds.length], due_at: new Date(Date.now() + (i - 3) * 86400000), priority: i % 4 === 0 ? 'high' : 'normal', is_demo: true });
  }
  return { leads: PEOPLE.length };
}

async function remove() {
  const ids = (await knex('leads').where({ is_demo: true }).select('student_id')).map((r) => r.student_id).filter(Boolean);
  await knex('tasks').where({ is_demo: true }).del();
  await knex('leads').where({ is_demo: true }).del();
  await knex('students').where({ is_demo: true }).orWhereIn('id', ids).del();
  const emps = await knex('employees').where({ is_demo: true }).select('user_id');
  await knex('users').whereIn('id', emps.map((e) => e.user_id)).del();
}

module.exports = { run, remove };
