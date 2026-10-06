// Demo website content taken from the original GEC site: services, resource articles, FAQs and testimonials, plus
// an About page and a Visa guidance page. Every row is is_demo = 1. Marketing claims that the platform cannot verify
// (approval rates, amounts "secured", "guaranteed" outcomes) are left out on purpose; testimonials are imported
// unpublished because there is no consent record for them yet.
const knex = require('../knex');
const gec = require('./data/gec-original.json');

const ICON = { Compass: 'compass', Building2: 'building', GraduationCap: 'graduation-cap', FileCheck: 'file-check', Award: 'award', FileText: 'file-text', ShieldCheck: 'shield-check', Plane: 'plane', Home: 'house', TrendingUp: 'trending-up', BookOpen: 'book-open', Users: 'users' };
const TIMELINE_AR = { '1 - 2 Business Days': '1 - 2 يوم عمل', '2 - 3 Business Days': '2 - 3 أيام عمل', '3 - 10 Business Days': '3 - 10 أيام عمل', 'Ongoing Support': 'دعم مستمر', '3 - 5 Business Days': '3 - 5 أيام عمل', '5 - 14 Days': '5 - 14 يومًا', '1 Week Before Travel': 'قبل السفر بأسبوع', '1 - 2 Weeks': '1 - 2 أسبوع', 'Flexible Intake': 'مواعيد مرنة', Flexible: 'مرن', 'First 30 Days in USA': 'أول 30 يومًا في الولايات المتحدة' };
const CATEGORY = { 'Student Visa': 'visa', 'Study in USA': 'study_abroad', 'University Admissions': 'application_tips', 'Scholarships & Budget': 'scholarships', 'Parent Guides': 'student_life' };
const FAQ_TOPIC = { Visas: 'visa', 'Work Rights': 'visa' };
const VERIFY_EN = '> This is general guidance. Rules, fees and requirements change — always confirm with the official government and university sources before you act.';
const VERIFY_AR = '> هذه إرشادات عامة. القواعد والرسوم والمتطلبات تتغير — تأكد دائمًا من المصادر الحكومية والجامعية الرسمية قبل اتخاذ أي إجراء.';

const PAGES = [
  {
    slug: 'about', title_en: 'About us', title_ar: 'من نحن', show_cta: true,
    lead_en: 'We help students choose, apply to and prepare for study abroad — with honest advice and clear next steps.',
    lead_ar: 'نساعد الطلاب على اختيار الدراسة في الخارج والتقديم لها والاستعداد لها — بنصيحة صادقة وخطوات واضحة.',
    body_en: '## What we do\nOur counsellors work with each student from the first conversation to arrival on campus: understanding goals and budget, shortlisting programs, preparing applications and documents, scholarships, visa preparation and pre-departure.\n\n## How we work\n- **Honest advice.** We explain your realistic options; no one can guarantee admission, a scholarship or a visa.\n- **One team, one record.** Your counsellor, documents, applications and messages are in one place you can see in your student portal.\n- **Your data is yours.** You can download or ask us to delete your data at any time.\n\n## Talk to us\nBook a free consultation and we will help you plan your next steps.',
    body_ar: '## ماذا نفعل\nيعمل مستشارونا مع كل طالب من المحادثة الأولى حتى الوصول إلى الجامعة: فهم الأهداف والميزانية، واختيار البرامج المناسبة، وتجهيز طلبات التقديم والمستندات، والمنح، والتحضير للتأشيرة، والاستعداد للسفر.\n\n## كيف نعمل\n- **نصيحة صادقة.** نشرح لك خياراتك الواقعية؛ لا أحد يستطيع ضمان القبول أو المنحة أو التأشيرة.\n- **فريق واحد وسجل واحد.** مستشارك ومستنداتك وطلباتك ورسائلك في مكان واحد تراه في بوابة الطالب.\n- **بياناتك ملكك.** يمكنك تنزيل بياناتك أو طلب حذفها في أي وقت.\n\n## تواصل معنا\nاحجز استشارة مجانية وسنساعدك على التخطيط لخطواتك التالية.',
  },
  {
    slug: 'visa', title_en: 'Student visa guidance', title_ar: 'إرشادات تأشيرة الطالب', show_cta: true,
    lead_en: 'How we help you prepare a student visa application — general guidance, not legal advice.',
    lead_ar: 'كيف نساعدك في تجهيز طلب تأشيرة الطالب — إرشاد عام وليس استشارة قانونية.',
    body_en: `## What we help with\n- A checklist of the documents your destination usually asks for (offer letter, proof of funds, passport, test results).\n- Reviewing that your forms and documents are complete and consistent before you submit them.\n- Mock interviews where an interview is required.\n- Tracking deadlines, appointment dates and the decision in your student portal.\n\n## What we do not do\nWe are not immigration lawyers and we do not give legal advice. The decision is made only by the embassy or immigration authority, and no one can guarantee a visa.\n\n## Typical steps\n1. Receive an unconditional offer (and, where required, a CAS, I-20 or acceptance letter).\n2. Prepare proof of funds and supporting documents.\n3. Complete the official online application and pay the official fees.\n4. Attend biometrics or an interview if required.\n5. Wait for the decision, then plan your travel.\n\n${VERIFY_EN}`,
    body_ar: `## بماذا نساعدك\n- قائمة بالمستندات التي تطلبها وجهتك عادةً (خطاب القبول، إثبات القدرة المالية، جواز السفر، نتائج الاختبارات).\n- مراجعة اكتمال النماذج والمستندات وتناسقها قبل تقديمها.\n- مقابلات تجريبية عندما تكون المقابلة مطلوبة.\n- متابعة المواعيد النهائية ومواعيد السفارة والقرار في بوابة الطالب.\n\n## ما لا نقوم به\nلسنا محامي هجرة ولا نقدم استشارات قانونية. القرار تتخذه السفارة أو سلطة الهجرة وحدها، ولا أحد يستطيع ضمان التأشيرة.\n\n## الخطوات المعتادة\n1. الحصول على قبول غير مشروط (وعند الحاجة CAS أو I-20 أو خطاب قبول).\n2. تجهيز إثبات القدرة المالية والمستندات الداعمة.\n3. تعبئة الطلب الرسمي عبر الإنترنت ودفع الرسوم الرسمية.\n4. حضور البصمات أو المقابلة إن لزم.\n5. انتظار القرار ثم التخطيط للسفر.\n\n${VERIFY_AR}`,
  },
];

const monthDate = (s) => { const d = new Date(`1 ${s} 12:00 UTC`); return Number.isNaN(d.getTime()) ? new Date() : d; };

async function run() {
  const out = { services: 0, articles: 0, faqs: 0, testimonials: 0, pages: 0 };
  for (const [i, s] of gec.servicesData.entries()) {
    if (await knex('services').where({ slug: s.slug }).first()) continue; // eslint-disable-line no-await-in-loop, no-continue
    await knex('services').insert({ // eslint-disable-line no-await-in-loop
      slug: s.slug, title_en: s.titleEn, title_ar: s.titleAr, description_en: s.descEn, description_ar: s.descAr, icon: ICON[s.iconName] || 'sparkles',
      timeline_en: s.timeline, timeline_ar: TIMELINE_AR[s.timeline] || null, deliverables_en: JSON.stringify(s.deliverablesEn || []), deliverables_ar: JSON.stringify(s.deliverablesAr || []),
      position: i + 1, is_published: true, is_demo: true,
    });
    out.services += 1;
  }
  for (const a of gec.resourcesData) {
    if (await knex('articles').where({ slug: a.id }).first()) continue; // eslint-disable-line no-await-in-loop, no-continue
    await knex('articles').insert({ // eslint-disable-line no-await-in-loop
      slug: a.id, title_en: a.titleEn, title_ar: a.titleAr, category: CATEGORY[a.category] || 'study_abroad', excerpt_en: a.excerptEn, excerpt_ar: a.excerptAr,
      body_en: `${a.excerptEn}\n\n${a.contentEn.replace(/\.\.\.$/, '.')}\n\n${VERIFY_EN}`, body_ar: `${a.excerptAr}\n\n${a.contentAr.replace(/\.\.\.$/, '.')}\n\n${VERIFY_AR}`,
      image: a.image, tags: JSON.stringify(a.tags || []), read_minutes: parseInt(a.readTime, 10) || null, published_at: monthDate(a.date), is_published: true, is_demo: true,
    });
    out.articles += 1;
  }
  if (!(await knex('faqs').where({ is_demo: true }).first())) {
    await knex('faqs').insert(gec.faqsData.map((f, i) => ({ category_en: f.category, category_ar: f.categoryAr, question_en: f.questionEn, question_ar: f.questionAr, answer_en: f.answerEn, answer_ar: f.answerAr, topic: FAQ_TOPIC[f.category] || null, position: i + 1, is_published: true, is_demo: true })));
    out.faqs = gec.faqsData.length;
  }
  if (!(await knex('testimonials').where({ is_demo: true }).first())) {
    await knex('testimonials').insert(gec.testimonialsData.map((q, i) => ({ name_en: q.nameEn, name_ar: q.nameAr, quote_en: q.quoteEn, quote_ar: q.quoteAr, country_en: q.countryEn, country_ar: q.countryAr, university_en: q.universityEn, university_ar: q.universityAr, program_en: q.programEn, program_ar: q.programAr, year: Number(q.year) || null, destination: q.destination || null, position: i + 1, consent_on_file: false, is_published: false, is_demo: true })));
    out.testimonials = gec.testimonialsData.length;
  }
  for (const p of PAGES) {
    if (await knex('pages').where({ slug: p.slug }).first()) continue; // eslint-disable-line no-await-in-loop, no-continue
    await knex('pages').insert({ ...p, is_published: true, is_demo: true }); // eslint-disable-line no-await-in-loop
    out.pages += 1;
  }
  return out;
}

async function remove() {
  for (const t of ['services', 'articles', 'faqs', 'testimonials', 'pages']) await knex(t).where({ is_demo: true }).del(); // eslint-disable-line no-await-in-loop
}

module.exports = { run, remove };
