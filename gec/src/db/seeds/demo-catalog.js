// Demo catalogue built from the content of the original GEC website (destinations, US states, universities,
// scholarships) plus a few illustrative programs and non-US universities so every destination can be searched.
// All figures are SAMPLE DATA for development and training: every row is is_demo = 1 and shows a "Demo" chip.
// Replace with verified data (or import a CSV) before publishing; `npm run seed -- --remove` deletes it.
const knex = require('../knex');
const money = require('../../modules/catalog/money');
const { slugify } = require('../../core/resource');
const gec = require('./data/gec-original.json');

const num = (s) => { const m = String(s || '').replace(/,/g, '').match(/\d+(\.\d+)?/g); return m ? m.map(Number) : []; };
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const monthsOf = (list) => [...new Set((list || []).map((x) => MONTHS[String(x).toLowerCase().split(/[\s(/]/)[0]]).filter(Boolean))];
const CURRENCY = { usa: 'USD', uk: 'GBP', canada: 'CAD', australia: 'AUD', germany: 'EUR', ireland: 'EUR' };
const COSTS = { // yearly calculator profile per destination, in its currency (illustrative)
  usa: { accommodation: 9000, food: 4000, transport: 900, insurance: 2200, visa: 535, flights: 1400, other: 2000 },
  uk: { accommodation: 7800, food: 3000, transport: 800, insurance: 776, visa: 524, flights: 700, other: 1500 },
  canada: { accommodation: 9600, food: 3800, transport: 1200, insurance: 900, visa: 150, flights: 1600, other: 1800 },
  australia: { accommodation: 13000, food: 5000, transport: 1500, insurance: 700, visa: 1600, flights: 2000, other: 2000 },
  germany: { accommodation: 5400, food: 2600, transport: 700, insurance: 1300, visa: 75, flights: 600, other: 1200 },
  ireland: { accommodation: 8400, food: 3000, transport: 800, insurance: 600, visa: 400, flights: 500, other: 1400 },
};

// Illustrative universities outside the US (the original site only listed US institutions).
const EXTRA_UNIS = [
  { slug: 'university-of-manchester-demo', dest: 'uk', name_en: 'The University of Manchester', name_ar: 'جامعة مانشستر', city_en: 'Manchester', city_ar: 'مانشستر', ranking_world: 34, type: 'public', tuition: [26000, 34000], ielts: 6.5, intakes: [9], fields: [['data_science', 'MSc Data Science', 'ماجستير علم البيانات', 'master', 12, 33000, 75], ['business', 'MSc International Business', 'ماجستير الأعمال الدولية', 'master', 12, 29000, 70], ['computer_science', 'BSc Computer Science', 'بكالوريوس علوم الحاسوب', 'bachelor', 36, 32000, 80]] },
  { slug: 'university-of-leeds-demo', dest: 'uk', name_en: 'University of Leeds', name_ar: 'جامعة ليدز', city_en: 'Leeds', city_ar: 'ليدز', ranking_world: 82, type: 'public', tuition: [24000, 31000], ielts: 6.5, intakes: [9, 1], fields: [['data_science', 'MSc Data Science and Analytics', 'ماجستير علم وتحليل البيانات', 'master', 12, 29750, 70], ['artificial_intelligence', 'MSc Artificial Intelligence', 'ماجستير الذكاء الاصطناعي', 'master', 12, 31000, 70]] },
  { slug: 'university-of-toronto-demo', dest: 'canada', name_en: 'University of Toronto', name_ar: 'جامعة تورنتو', city_en: 'Toronto', city_ar: 'تورنتو', ranking_world: 25, type: 'public', tuition: [45000, 65000], ielts: 7, intakes: [9], fields: [['computer_science', 'BSc Computer Science', 'بكالوريوس علوم الحاسوب', 'bachelor', 48, 64000, 85], ['data_science', 'Master of Science in Applied Computing', 'ماجستير الحوسبة التطبيقية', 'master', 16, 52000, 80]] },
  { slug: 'university-of-melbourne-demo', dest: 'australia', name_en: 'The University of Melbourne', name_ar: 'جامعة ملبورن', city_en: 'Melbourne', city_ar: 'ملبورن', ranking_world: 13, type: 'public', tuition: [42000, 50000], ielts: 6.5, intakes: [2, 7], fields: [['data_science', 'Master of Data Science', 'ماجستير علم البيانات', 'master', 24, 49000, 75], ['engineering', 'Master of Engineering', 'ماجستير الهندسة', 'master', 36, 48000, 70]] },
  { slug: 'tu-munich-demo', dest: 'germany', name_en: 'Technical University of Munich', name_ar: 'جامعة ميونخ التقنية', city_en: 'Munich', city_ar: 'ميونخ', ranking_world: 28, type: 'public', tuition: [4000, 6000], ielts: 6.5, intakes: [10, 4], fields: [['data_science', 'MSc Data Engineering and Analytics', 'ماجستير هندسة وتحليل البيانات', 'master', 24, 6000, 80], ['engineering', 'MSc Mechanical Engineering', 'ماجستير الهندسة الميكانيكية', 'master', 24, 6000, 80]] },
  { slug: 'university-college-dublin-demo', dest: 'ireland', name_en: 'University College Dublin', name_ar: 'جامعة كلية دبلن', city_en: 'Dublin', city_ar: 'دبلن', ranking_world: 126, type: 'public', tuition: [24000, 30000], ielts: 6.5, intakes: [9], fields: [['data_science', 'MSc Data and Computational Science', 'ماجستير علوم البيانات والحوسبة', 'master', 12, 27500, 70], ['business', 'MSc Business Analytics', 'ماجستير تحليلات الأعمال', 'master', 12, 29500, 70]] },
];

// Programs at the original US universities, from the majors each one listed.
const FIELD_OF = (name) => {
  const n = name.toLowerCase();
  if (/artificial intelligence|robotics/.test(n)) return 'artificial_intelligence';
  if (/data|analytics/.test(n)) return 'data_science';
  if (/cyber/.test(n)) return 'cybersecurity';
  if (/computer|software|information systems/.test(n)) return 'computer_science';
  if (/engineering|aviation/.test(n)) return 'engineering';
  if (/finance|account/.test(n)) return 'finance';
  if (/marketing/.test(n)) return 'marketing';
  if (/health|biomedical|biotech/.test(n)) return 'health';
  if (/animation|design/.test(n)) return 'design';
  if (/business|mba|supply chain/.test(n)) return 'business';
  return 'other';
};

async function run() {
  if (await knex('destinations').where({ is_demo: true }).first('id')) return { skipped: true };
  const destIds = {};
  let pos = 0;
  for (const d of gec.destinationsData) {
    const t = num(d.avgTuition);
    const l = num(d.avgLivingCost);
    const yearlyLiving = /year/.test(d.avgLivingCost);
    const regions = d.id === 'usa' ? gec.usStatesData.map((s) => ({ name_en: s.name, name_ar: s.nameAr, badge: s.badge, overview_en: s.overviewEn, overview_ar: s.overviewAr, tuition: s.avgTuitionRange, living: s.avgLivingCost })) : null;
    const [id] = await knex('destinations').insert({
      slug: d.id, country_code: d.code, name_en: d.country, name_ar: d.countryAr, tagline_en: d.taglineEn, tagline_ar: d.taglineAr,
      why_en: JSON.stringify(d.whyStudyEn || []), why_ar: JSON.stringify(d.whyStudyAr || []), hero_image: d.heroImage, currency: CURRENCY[d.id] || 'USD',
      tuition_min: t[0] ?? null, tuition_max: t[1] ?? t[0] ?? null,
      living_month_min: l.length ? Math.round(l[0] / (yearlyLiving ? 12 : 1)) : null, living_month_max: l.length ? Math.round((l[1] || l[0]) / (yearlyLiving ? 12 : 1)) : null,
      post_study_work_en: d.postStudyWork, post_study_work_ar: d.postStudyWorkAr, visa_type: d.visaType, intakes_en: d.intakesEn, intakes_ar: d.intakesAr,
      regions: regions ? JSON.stringify(regions) : null, cost_profile: JSON.stringify(COSTS[d.id] || {}), position: pos += 1, is_featured: true, is_demo: true,
    });
    destIds[d.id] = id;
  }

  const uniIds = {};
  for (const u of gec.universitiesData) {
    const ug = num(u.tuitionUndergrad)[0] || null;
    const gr = num(u.tuitionGraduate)[0] || null;
    const ielts = (/IELTS\s*([\d.]+)/.exec(u.toeflIelts || '') || [])[1];
    const toefl = (/TOEFL\s*(\d+)/.exec(u.toeflIelts || '') || [])[1];
    const duo = (/Duolingo\s*(\d+)/.exec(u.toeflIelts || '') || [])[1];
    const [id] = await knex('universities').insert({
      slug: u.id, name_en: u.name, name_ar: u.nameAr, destination_id: destIds.usa, country_code: 'US', city_en: u.city, city_ar: u.cityAr, state: u.state || null,
      logo: u.logo, cover_image: u.image, description_en: u.overviewEn || u.descriptionEn, description_ar: u.overviewAr || u.descriptionAr,
      ranking_world: u.worldRanking || null, ranking_source: 'Sample figure (demo)', institution_type: /community/i.test(u.name) ? 'community_college' : u.id === 'usf-florida' || u.id === 'asu-arizona' ? 'public' : 'private',
      currency: 'USD', tuition_min: Math.min(...[ug, gr].filter(Boolean)), tuition_max: Math.max(...[ug, gr].filter(Boolean)), application_fee: 50,
      admission_en: [u.accreditation ? `Accreditation: ${u.accreditation}` : null, u.satRequired ? `SAT: ${u.satRequired}` : null, `English: ${u.toeflIelts}`].filter(Boolean).join('\n\n'),
      admission_ar: [u.accreditationAr, u.toeflIelts].filter(Boolean).join('\n\n'),
      min_ielts: ielts ? Number(ielts) : null, min_toefl: toefl ? Number(toefl) : null, min_duolingo: duo ? Number(duo) : null,
      intakes: JSON.stringify(monthsOf(u.intakeMonths)), documents_required: JSON.stringify(['Passport', 'Transcripts', 'English test result', 'Statement of purpose', 'Financial documents']),
      partner_status: 'active', commission_note: 'Demo: 10–15% of first-year tuition (sample).', internal_notes: 'Demo record from the original GEC website.', is_featured: Boolean(u.featured) || ['illinois-tech', 'depaul-university'].includes(u.id), is_demo: true,
    });
    uniIds[u.id] = id;
    // its programs
    for (const [i, major] of (u.programsOffered || []).entries()) {
      const field = FIELD_OF(major);
      const levels = (u.degreesOffered || []).filter((x) => x === 'Bachelor' || x === 'Master');
      for (const lvl of levels.length ? levels : ['Bachelor']) {
        if (u.id === 'seattle-colleges' && lvl !== 'Bachelor') continue; // eslint-disable-line no-continue
        const degree = u.id === 'seattle-colleges' ? 'diploma' : lvl.toLowerCase();
        const fee = degree === 'master' ? (gr || ug) : ug;
        const name = degree === 'master' ? `MS ${major.replace(/\s*\(.*\)/, '')}` : degree === 'diploma' ? major : `BS ${major.replace(/\s*\(.*\)/, '')}`;
        const nameAr = degree === 'master' ? `ماجستير ${(u.programsOfferedAr || [])[i] || major}` : degree === 'diploma' ? ((u.programsOfferedAr || [])[i] || major) : `بكالوريوس ${(u.programsOfferedAr || [])[i] || major}`;
        let slug = slugify(`${name}-${u.id}`);
        for (let n = 2; await knex('programs').where({ slug }).first('id'); n += 1) slug = `${slugify(`${name}-${u.id}`)}-${n}`; // eslint-disable-line no-await-in-loop
        await knex('programs').insert({ // eslint-disable-line no-await-in-loop
          slug, university_id: id, name_en: name, name_ar: nameAr, degree_level: degree, field, duration_months: degree === 'master' ? 24 : degree === 'diploma' ? 24 : 48,
          currency: 'USD', tuition_fee: fee, tuition_usd: fee, application_fee: 50, intakes: JSON.stringify(monthsOf(u.intakeMonths)), next_deadline: monthsOf(u.intakeMonths).includes(1) ? '2026-11-15' : '2027-03-01',
          min_gpa_pct: degree === 'master' ? 75 : 70, min_ielts: ielts ? Number(ielts) : null, min_toefl: toefl ? Number(toefl) : null, min_duolingo: duo ? Number(duo) : null,
          documents_required: JSON.stringify(degree === 'master' ? ['Bachelor\'s transcript', 'Degree certificate', 'English test result', 'CV', 'Statement of purpose', '2 recommendation letters'] : ['High school transcript', 'English test result', 'Passport']),
          scholarships_available: Boolean(u.scholarshipsAvailable), internship: /co-op/i.test(major) ? 'coop' : 'optional', study_mode: 'on_campus',
          work_after_study: Boolean(u.stemPrograms) && ['computer_science', 'data_science', 'artificial_intelligence', 'cybersecurity', 'engineering'].includes(field),
          work_after_study_note: 'STEM OPT: up to 3 years of practical training (rules can change).', description_en: `Sample ${degree} program at ${u.name}.`, is_demo: true,
        });
      }
    }
  }

  for (const x of EXTRA_UNIS) {
    const [id] = await knex('universities').insert({
      slug: x.slug, name_en: x.name_en, name_ar: x.name_ar, destination_id: destIds[x.dest], country_code: gec.destinationsData.find((d) => d.id === x.dest).code, city_en: x.city_en, city_ar: x.city_ar,
      ranking_world: x.ranking_world, ranking_source: 'Approximate, for demo only', institution_type: x.type, currency: CURRENCY[x.dest], tuition_min: x.tuition[0], tuition_max: x.tuition[1],
      min_ielts: x.ielts, intakes: JSON.stringify(x.intakes), partner_status: 'prospect', description_en: `Sample record for ${x.name_en} (demo data — verify before publishing).`, is_demo: true,
    });
    for (const [field, en, ar, degree, months, fee, gpa] of x.fields) {
      await knex('programs').insert({ // eslint-disable-line no-await-in-loop
        slug: slugify(`${en}-${x.slug}`), university_id: id, name_en: en, name_ar: ar, degree_level: degree, field, duration_months: months, currency: CURRENCY[x.dest], tuition_fee: fee,
        tuition_usd: await money.toUsd(fee, CURRENCY[x.dest]), application_fee: x.dest === 'uk' ? 0 : 75, intakes: JSON.stringify(x.intakes), next_deadline: '2027-01-31', min_gpa_pct: gpa, min_ielts: x.ielts, // eslint-disable-line no-await-in-loop
        min_ielts_band: x.ielts - 0.5, documents_required: JSON.stringify(['Transcript', 'Degree certificate', 'English test result', 'CV', 'Personal statement']), scholarships_available: true,
        internship: 'optional', work_after_study: true, work_after_study_note: x.dest === 'uk' ? 'Graduate Route: 2 years (rules can change).' : 'Post-study work rights available (rules can change).',
        description_en: 'Sample program (demo data).', is_demo: true,
      });
    }
  }

  for (const s of gec.scholarshipsData) {
    const amounts = num(s.amount);
    const full = /100%|full/i.test(`${s.amount} ${s.coverage}`);
    const uni = s.id.startsWith('illinois-tech') ? uniIds['illinois-tech'] : s.id.startsWith('usf') ? uniIds['usf-florida'] : s.id.startsWith('depaul') ? uniIds['depaul-university'] : null;
    const dest = { 'United States': 'usa', 'United Kingdom': 'uk', Australia: 'australia' }[s.country];
    await knex('scholarships').insert({ // eslint-disable-line no-await-in-loop
      slug: s.id, name_en: s.titleEn, name_ar: s.titleAr, university_id: uni, destination_id: destIds[dest] || null, provider_en: s.provider, provider_ar: s.providerAr,
      amount_type: full ? 'full' : 'fixed', amount_min: full ? null : amounts[0] || null, amount_max: full ? null : amounts[1] || null, currency: 'USD',
      coverage_en: s.coverage, coverage_ar: s.coverageAr, description_en: s.descriptionEn, description_ar: s.descriptionAr,
      eligibility_en: JSON.stringify(s.eligibilityEn || []), eligibility_ar: JSON.stringify(s.eligibilityAr || []), nationalities: JSON.stringify([]),
      degree_levels: JSON.stringify((s.degreeLevel || []).map((x) => x.toLowerCase())), deadline: null, deadline_note: s.deadline, is_demo: true,
    });
  }
  return { destinations: Object.keys(destIds).length, universities: Object.keys(uniIds).length + EXTRA_UNIS.length, programs: Number((await knex('programs').count({ n: '*' }))[0].n) };
}

async function remove() {
  await knex('scholarships').where({ is_demo: true }).del();
  await knex('programs').where({ is_demo: true }).del();
  await knex('universities').where({ is_demo: true }).del();
  await knex('destinations').where({ is_demo: true }).del();
}

module.exports = { run, remove };
