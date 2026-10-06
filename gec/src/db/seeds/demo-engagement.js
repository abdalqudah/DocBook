// Demo engagement data: two consultation types with weekly hours for the demo counsellors, the three events from
// the original GEC website (dates as published there), and two sample courses. Every row is is_demo = 1.
const knex = require('../knex');
const gec = require('./data/gec-original.json');

const TYPE_OF = { 'Education Fair': 'fair', Webinar: 'webinar', 'USA Seminar': 'info_session' };
// Start times as published on the original site, converted to UTC.
const EVENT_TIMES = { 'usa-admissions-fair-2026': ['2026-10-15T23:00:00Z', '2026-10-16T02:30:00Z'], 'f1-visa-masterclass': ['2026-11-08T16:00:00Z', '2026-11-08T17:30:00Z'], 'stem-opt-career-summit': ['2026-12-02T23:00:00Z', '2026-12-03T00:30:00Z'] };

async function run() {
  const emps = await knex('employees').where({ is_counsellor: true }).orderBy('id').limit(4).pluck('id');
  const types = [
    { slug: 'free-consultation', name_en: 'Free study-abroad consultation', name_ar: 'استشارة مجانية للدراسة في الخارج', description_en: 'A 30-minute call to understand your goals, budget and options, and agree your next steps.', description_ar: 'مكالمة مدتها 30 دقيقة لفهم أهدافك وميزانيتك وخياراتك والاتفاق على الخطوات التالية.', duration_min: 30, buffer_min: 10, location_mode: 'both', position: 1 },
    { slug: 'visa-preparation', name_en: 'Visa interview preparation', name_ar: 'التحضير لمقابلة التأشيرة', description_en: 'A mock interview and document check before your embassy appointment. General guidance only — not legal advice.', description_ar: 'مقابلة تجريبية ومراجعة للمستندات قبل موعد السفارة. إرشاد عام وليس استشارة قانونية.', duration_min: 45, buffer_min: 15, location_mode: 'online', position: 2, min_notice_hours: 24 },
  ];
  let n = 0;
  for (const t of types) {
    if (await knex('appointment_types').where({ slug: t.slug }).first()) continue; // eslint-disable-line no-await-in-loop, no-continue
    const [id] = await knex('appointment_types').insert({ ...t, is_demo: true }); // eslint-disable-line no-await-in-loop
    if (emps.length) await knex('appointment_type_staff').insert(emps.map((e) => ({ type_id: id, employee_id: e }))); // eslint-disable-line no-await-in-loop
    n += 1;
  }
  for (const e of emps) {
    if (await knex('availability').where({ employee_id: e }).first()) continue; // eslint-disable-line no-await-in-loop, no-continue
    const rows = [];
    for (const wd of [0, 1, 2, 3, 4]) { rows.push({ employee_id: e, weekday: wd, start_time: '09:00', end_time: '13:00' }, { employee_id: e, weekday: wd, start_time: '14:00', end_time: '17:00' }); } // Sun–Thu
    await knex('availability').insert(rows); // eslint-disable-line no-await-in-loop
  }
  for (const ev of gec.eventsData) {
    if (await knex('events').where({ slug: ev.id }).first()) continue; // eslint-disable-line no-await-in-loop, no-continue
    const [s, e] = EVENT_TIMES[ev.id] || [new Date(ev.date).toISOString(), null];
    await knex('events').insert({ // eslint-disable-line no-await-in-loop
      slug: ev.id, title_en: ev.titleEn, title_ar: ev.titleAr, type: TYPE_OF[ev.type] || 'other', description_en: ev.descriptionEn, description_ar: ev.descriptionAr, image: ev.image,
      starts_at: new Date(s), ends_at: e ? new Date(e) : null, is_virtual: !!ev.isVirtual, location_en: ev.locationEn, location_ar: ev.locationAr, capacity: 300, registration_open: ev.registrationOpen !== false,
      speakers_en: JSON.stringify(ev.featuredSpeakersEn || []), speakers_ar: JSON.stringify(ev.featuredSpeakersAr || []), is_active: true, is_demo: true,
    });
  }
  const courses = [
    { slug: 'ielts-preparation-demo', name_en: 'IELTS Academic preparation', name_ar: 'التحضير لاختبار IELTS الأكاديمي', description_en: 'Eight evening sessions covering all four skills, with two full mock tests and feedback on your writing.\n\n*Sample course (demo data).*', description_ar: 'ثماني جلسات مسائية تغطي المهارات الأربع مع اختبارين تجريبيين كاملين وملاحظات على الكتابة.\n\n*دورة تجريبية (بيانات عرض).*', mode: 'blended', location: 'GEC Amman office', start_date: '2026-11-01', end_date: '2026-11-26', schedule_en: 'Sun & Wed, 6–8 pm', schedule_ar: 'الأحد والأربعاء، 6–8 مساءً', capacity: 12, price: 180, currency: 'USD', instructor_name: 'GEC language team' },
    { slug: 'study-skills-demo', name_en: 'Academic writing & study skills', name_ar: 'الكتابة الأكاديمية ومهارات الدراسة', description_en: 'A free online workshop series before you travel: essays, referencing, and how seminars work.\n\n*Sample course (demo data).*', description_ar: 'سلسلة ورش مجانية عن بُعد قبل السفر: المقالات والتوثيق وطريقة عمل الحلقات النقاشية.\n\n*دورة تجريبية (بيانات عرض).*', mode: 'online', start_date: '2026-12-06', end_date: '2026-12-20', schedule_en: 'Sundays, 7 pm', schedule_ar: 'أيام الأحد، 7 مساءً', capacity: 40, price: null, currency: 'USD', instructor_name: 'GEC advisors' },
  ];
  for (const c of courses) {
    if (await knex('courses').where({ slug: c.slug }).first()) continue; // eslint-disable-line no-await-in-loop, no-continue
    const [id] = await knex('courses').insert({ ...c, is_demo: true }); // eslint-disable-line no-await-in-loop
    const start = new Date(`${c.start_date}T15:00:00Z`);
    await knex('course_sessions').insert([0, 3, 7, 10].map((d, i) => ({ course_id: id, starts_at: new Date(start.getTime() + d * 86400_000), ends_at: new Date(start.getTime() + d * 86400_000 + 2 * 3600_000), topic: `Session ${i + 1}` }))); // eslint-disable-line no-await-in-loop
  }
  return { appointment_types: n, counsellors: emps.length, events: gec.eventsData.length, courses: courses.length };
}

async function remove() {
  await knex('appointments').where({ is_demo: true }).del();
  const typeIds = await knex('appointment_types').where({ is_demo: true }).pluck('id');
  if (typeIds.length) { await knex('appointments').whereIn('type_id', typeIds).del(); await knex('appointment_types').whereIn('id', typeIds).del(); }
  const demoEmps = await knex('employees').where({ is_demo: true }).pluck('id');
  if (demoEmps.length) await knex('availability').whereIn('employee_id', demoEmps).del();
  await knex('courses').where({ is_demo: true }).del();
  await knex('events').where({ is_demo: true }).del();
}

module.exports = { run, remove };
