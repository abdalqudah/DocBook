// Lead pipeline stages (configurable in Settings → Lead stages) and lead sources.
const knex = require('../../db/knex');

const DEFAULT_STAGES = [
  ['new', 'New Lead', 'عميل جديد', 'info'],
  ['attempted', 'Attempted Contact', 'محاولة تواصل', 'warn'],
  ['contacted', 'Contacted', 'تم التواصل', 'brand'],
  ['qualified', 'Qualified', 'مؤهَّل', 'brand'],
  ['counselling_booked', 'Counselling Booked', 'تم حجز الاستشارة', 'brand'],
  ['counselling_done', 'Counselling Completed', 'اكتملت الاستشارة', 'brand'],
  ['documents_requested', 'Documents Requested', 'طُلبت المستندات', 'warn'],
  ['application_started', 'Application Started', 'بدأ التقديم', 'brand'],
  ['application_submitted', 'Application Submitted', 'تم تقديم الطلب', 'brand'],
  ['offer_received', 'Offer Received', 'تم استلام القبول', 'ok'],
  ['visa_stage', 'Visa Stage', 'مرحلة التأشيرة', 'ok'],
  ['enrolled', 'Enrolled', 'التحق بالدراسة', 'ok', { is_won: true }],
  ['lost', 'Lost', 'مفقود', 'bad', { is_lost: true }],
];

const DEFAULT_SOURCES = [
  ['contact_form', 'Contact form', 'نموذج التواصل'], ['consultation', 'Consultation booking', 'حجز استشارة'], ['whatsapp', 'WhatsApp', 'واتساب'],
  ['course_inquiry', 'Course inquiry', 'استفسار عن دورة'], ['university_inquiry', 'University inquiry', 'استفسار عن جامعة'], ['program_inquiry', 'Program inquiry', 'استفسار عن برنامج'],
  ['scholarship_inquiry', 'Scholarship inquiry', 'استفسار عن منحة'], ['event', 'Event registration', 'تسجيل في فعالية'], ['download', 'Download form', 'نموذج تنزيل'],
  ['newsletter', 'Newsletter', 'النشرة البريدية'], ['manual', 'Manual entry', 'إدخال يدوي'], ['referral', 'Referral', 'إحالة'], ['social', 'Social campaign', 'حملة تواصل اجتماعي'],
  ['google_ads', 'Google Ads', 'إعلانات جوجل'], ['walk_in', 'Walk-in', 'زيارة المكتب'], ['phone', 'Phone call', 'اتصال هاتفي'], ['ai_advisor', 'AI study advisor', 'المستشار الذكي'],
];

async function ensureDefaults() {
  if (!(await knex('lead_stages').first('id'))) {
    await knex('lead_stages').insert(DEFAULT_STAGES.map(([key, en, ar, tone, extra], i) => ({ key, name_en: en, name_ar: ar, tone, position: i, ...(extra || {}) })));
  }
  for (const [key, en, ar] of DEFAULT_SOURCES) {
    await knex.raw('INSERT IGNORE INTO lead_sources (`key`, name_en, name_ar, is_system) VALUES (?, ?, ?, 1)', [key, en, ar]); // eslint-disable-line no-await-in-loop
  }
}

let cache = null;
async function all({ fresh = false } = {}) {
  if (!cache || fresh) cache = await knex('lead_stages').orderBy('position');
  return cache;
}
const clear = () => { cache = null; };
async function byKey(key) { return (await all()).find((s) => s.key === key); }
async function first() { return (await all()).find((s) => s.is_active && !s.is_lost && !s.is_won); }
async function sources() { return knex('lead_sources').orderBy('name_en'); }

module.exports = { ensureDefaults, all, clear, byKey, first, sources, DEFAULT_STAGES };
