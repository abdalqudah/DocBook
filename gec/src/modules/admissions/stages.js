// Application pipeline stages (configurable in Settings → Application stages) and document types.
const knex = require('../../db/knex');

// key, English, Arabic, tone, student journey, lead stage, SLA days, flags
const DEFAULT_STAGES = [
  ['lead', 'Lead', 'عميل محتمل', 'info', 'profile', null, null],
  ['profile_started', 'Profile Started', 'بدأ الملف', 'info', 'profile', null, 7],
  ['profile_complete', 'Profile Complete', 'اكتمل الملف', 'brand', 'counselling', null, 7],
  ['counselling', 'Counselling', 'الاستشارة', 'brand', 'counselling', 'counselling_done', 7],
  ['shortlisting', 'Shortlisting', 'اختيار البرامج', 'brand', 'program_selection', 'counselling_done', 7],
  ['documents_pending', 'Documents Pending', 'بانتظار المستندات', 'warn', 'documents', 'documents_requested', 5],
  ['documents_complete', 'Documents Complete', 'اكتملت المستندات', 'brand', 'documents', 'documents_requested', 3],
  ['application_ready', 'Application Ready', 'الطلب جاهز', 'brand', 'application', 'application_started', 3],
  ['submitted', 'Submitted', 'تم التقديم', 'brand', 'application', 'application_submitted', 21],
  ['university_review', 'University Review', 'قيد مراجعة الجامعة', 'info', 'application', 'application_submitted', 30],
  ['conditional_offer', 'Conditional Offer', 'قبول مشروط', 'ok', 'offer', 'offer_received', 14],
  ['unconditional_offer', 'Unconditional Offer', 'قبول غير مشروط', 'ok', 'offer', 'offer_received', 7],
  ['deposit_pending', 'Deposit Pending', 'بانتظار دفع العربون', 'warn', 'offer', 'offer_received', 14],
  ['deposit_paid', 'Deposit Paid', 'تم دفع العربون', 'ok', 'offer', 'offer_received', 7],
  ['cas_issued', 'CAS / COE / I-20', 'CAS / COE / I-20', 'ok', 'offer', 'offer_received', 7],
  ['visa_preparation', 'Visa Preparation', 'تجهيز التأشيرة', 'brand', 'visa', 'visa_stage', 14],
  ['visa_submitted', 'Visa Submitted', 'تم تقديم التأشيرة', 'info', 'visa', 'visa_stage', 30],
  ['visa_approved', 'Visa Approved', 'تمت الموافقة على التأشيرة', 'ok', 'visa', 'visa_stage', null],
  ['visa_refused', 'Visa Refused', 'رُفضت التأشيرة', 'bad', 'visa', 'visa_stage', null],
  ['pre_departure', 'Pre-Departure', 'ما قبل السفر', 'brand', 'pre_departure', 'visa_stage', null],
  ['enrolled', 'Enrolled', 'التحق بالدراسة', 'ok', 'enrolled', 'enrolled', null, { is_terminal: true, is_success: true }],
  ['closed', 'Closed', 'مغلق', 'bad', null, null, null, { is_terminal: true }],
];

const DOC_TYPES = [
  ['passport', 'Passport', 'جواز السفر', 'identity', true], ['photo', 'Personal photo', 'صورة شخصية', 'identity', false], ['national_id', 'National ID', 'الهوية الوطنية', 'identity', true],
  ['transcript', 'Transcript', 'كشف العلامات', 'academic', false], ['certificate', 'Degree / school certificate', 'الشهادة', 'academic', false],
  ['ielts', 'IELTS result', 'نتيجة الآيلتس', 'english', true], ['toefl', 'TOEFL result', 'نتيجة التوفل', 'english', true], ['pte', 'PTE result', 'نتيجة PTE', 'english', true], ['duolingo', 'Duolingo result', 'نتيجة Duolingo', 'english', true],
  ['cv', 'CV / résumé', 'السيرة الذاتية', 'application', false], ['sop', 'Statement of purpose', 'رسالة الدوافع', 'application', false], ['recommendation', 'Recommendation letter', 'رسالة توصية', 'application', false],
  ['portfolio', 'Portfolio', 'ملف الأعمال', 'application', false], ['offer_letter', 'Offer letter', 'خطاب القبول', 'application', false], ['cas', 'CAS / COE / I-20', 'CAS / COE / I-20', 'visa', true],
  ['bank_statement', 'Bank statement', 'كشف حساب بنكي', 'financial', true], ['sponsor_letter', 'Sponsor letter', 'خطاب الكفالة', 'financial', false], ['scholarship_letter', 'Scholarship letter', 'خطاب المنحة', 'financial', false],
  ['visa_form', 'Visa application form', 'نموذج طلب التأشيرة', 'visa', false], ['medical', 'Medical / TB test', 'الفحص الطبي', 'visa', true], ['insurance', 'Health insurance', 'التأمين الصحي', 'visa', true],
  ['police', 'Police clearance', 'شهادة عدم محكومية', 'visa', true], ['visa', 'Visa', 'التأشيرة', 'visa', true], ['other', 'Other document', 'مستند آخر', 'other', false],
];

async function ensureDefaults() {
  if (!(await knex('application_stages').first('id'))) {
    await knex('application_stages').insert(DEFAULT_STAGES.map(([key, en, ar, tone, journey, lead, sla, extra], i) => ({ key, name_en: en, name_ar: ar, tone, journey, lead_stage: lead, sla_days: sla, position: i, ...(extra || {}) })));
  }
  for (const [i, [key, en, ar, cat, exp]] of DOC_TYPES.entries()) {
    await knex.raw('INSERT IGNORE INTO document_types (`key`, name_en, name_ar, category, has_expiry, position) VALUES (?, ?, ?, ?, ?, ?)', [key, en, ar, cat, exp, i]); // eslint-disable-line no-await-in-loop
  }
}

let cache = null;
async function all({ fresh = false } = {}) { if (!cache || fresh) cache = await knex('application_stages').orderBy('position'); return cache; }
const clear = () => { cache = null; };
async function byKey(key) { return (await all()).find((s) => s.key === key); }
async function docTypes() { return knex('document_types').where({ is_active: true }).orderBy('position'); }

module.exports = { ensureDefaults, all, clear, byKey, docTypes, DEFAULT_STAGES, DOC_TYPES };
