// Message templates with {{variables}}. Built-in defaults (English / Arabic) live here; Settings → Templates
// (phase 6) stores edited versions in the database, which win. Variables are escaped when rendered into HTML.
const knex = require('../../db/knex');

const D = (subjectEn, bodyEn, subjectAr, bodyAr, ctaEn = null, ctaAr = null) => ({ en: { subject: subjectEn, body: bodyEn, cta: ctaEn }, ar: { subject: subjectAr, body: bodyAr, cta: ctaAr } });

const DEFAULTS = {
  welcome: D('Welcome to {{company_name}}', 'Hello {{student_name}},\n\nThank you for contacting {{company_name}}. Your counsellor {{counsellor_name}} will guide you through every step — from choosing programs to your visa.\n\nYou can follow your journey in your student portal.',
    'مرحباً بك في {{company_name}}', 'مرحباً {{student_name}}،\n\nشكراً لتواصلك مع {{company_name}}. سيرافقك مستشارك {{counsellor_name}} في كل خطوة — من اختيار البرامج حتى التأشيرة.\n\nيمكنك متابعة رحلتك عبر بوابة الطالب.', 'Open my portal', 'فتح بوابتي'),
  consultation_confirmation: D('Your {{appointment_type}} is booked', 'Hello {{student_name}},\n\nYour {{appointment_type}} with {{counsellor_name}} is confirmed for {{appointment_date}}.\n{{appointment_place}}\n\nNeed to change it? Use the button below.',
    'تم حجز {{appointment_type}}', 'مرحباً {{student_name}}،\n\nتم تأكيد {{appointment_type}} مع {{counsellor_name}} في {{appointment_date}}.\n{{appointment_place}}\n\nتحتاج إلى تغيير الموعد؟ استخدم الزر أدناه.', 'Manage my booking', 'إدارة الحجز'),
  appointment_reminder: D('Reminder: {{appointment_type}} on {{appointment_date}}', 'Hello {{student_name}},\n\nThis is a reminder of your {{appointment_type}} with {{counsellor_name}} on {{appointment_date}}.\n{{appointment_place}}',
    'تذكير: {{appointment_type}} في {{appointment_date}}', 'مرحباً {{student_name}}،\n\nنذكّرك بموعد {{appointment_type}} مع {{counsellor_name}} في {{appointment_date}}.\n{{appointment_place}}', 'View my booking', 'عرض الحجز'),
  missing_documents: D('Documents needed for your application', 'Hello {{student_name}},\n\nPlease upload: {{document_name}}{{due_text}}.\n{{note}}',
    'مستندات مطلوبة لطلبك', 'مرحباً {{student_name}}،\n\nيرجى رفع: {{document_name}}{{due_text}}.\n{{note}}', 'Upload documents', 'رفع المستندات'),
  document_rejected: D('Please re-upload: {{document_name}}', 'Hello {{student_name}},\n\nWe could not accept your {{document_name}}: {{reason}}\n\nPlease upload a new version.',
    'يرجى إعادة رفع: {{document_name}}', 'مرحباً {{student_name}}،\n\nلم نتمكن من قبول {{document_name}}: {{reason}}\n\nيرجى رفع نسخة جديدة.', 'Upload again', 'إعادة الرفع'),
  application_submitted: D('Your application to {{university_name}} was submitted', 'Hello {{student_name}},\n\nGood news: your application for {{program_name}} at {{university_name}} has been submitted. We will let you know as soon as the university replies.',
    'تم تقديم طلبك إلى {{university_name}}', 'مرحباً {{student_name}}،\n\nأخبار جيدة: تم تقديم طلبك لبرنامج {{program_name}} في {{university_name}}. سنبلغك فور رد الجامعة.', 'Track my application', 'متابعة طلبي'),
  offer_received: D('Congratulations — an offer from {{university_name}}', 'Hello {{student_name}},\n\nYou have received a {{offer_type}} for {{program_name}} at {{university_name}}. Your counsellor {{counsellor_name}} will contact you about the next steps.',
    'مبروك — قبول من {{university_name}}', 'مرحباً {{student_name}}،\n\nحصلت على {{offer_type}} لبرنامج {{program_name}} في {{university_name}}. سيتواصل معك مستشارك {{counsellor_name}} بخصوص الخطوات التالية.', 'See my offer', 'عرض القبول'),
  application_status: D('Update on your application: {{application_status}}', 'Hello {{student_name}},\n\nYour application for {{program_name}} at {{university_name}} is now: {{application_status}}.',
    'تحديث على طلبك: {{application_status}}', 'مرحباً {{student_name}}،\n\nأصبح طلبك لبرنامج {{program_name}} في {{university_name}}: {{application_status}}.', 'Track my application', 'متابعة طلبي'),
  visa_update: D('Visa update: {{visa_status}}', 'Hello {{student_name}},\n\nYour {{visa_country}} visa case is now: {{visa_status}}.\n\nThis message is for information only and is not legal advice.',
    'تحديث التأشيرة: {{visa_status}}', 'مرحباً {{student_name}}،\n\nأصبح ملف تأشيرة {{visa_country}} الخاص بك: {{visa_status}}.\n\nهذه الرسالة للعلم فقط وليست استشارة قانونية.', 'Open my portal', 'فتح بوابتي'),
  course_registration: D('Registration received: {{course_name}}', 'Hello {{student_name}},\n\nThank you for registering for {{course_name}} ({{course_dates}}). Status: {{registration_status}}.{{payment_text}}',
    'استلمنا تسجيلك: {{course_name}}', 'مرحباً {{student_name}}،\n\nشكراً لتسجيلك في {{course_name}} ({{course_dates}}). الحالة: {{registration_status}}.{{payment_text}}', 'Manage my registration', 'إدارة التسجيل'),
  event_registration: D('Your ticket: {{event_name}}', 'Hello {{student_name}},\n\nYou are registered for {{event_name}} on {{event_date}}.\n{{event_place}}\n\nShow the QR code on your ticket at the entrance.',
    'تذكرتك: {{event_name}}', 'مرحباً {{student_name}}،\n\nتم تسجيلك في {{event_name}} في {{event_date}}.\n{{event_place}}\n\nأظهر رمز QR في تذكرتك عند الدخول.', 'Open my ticket', 'فتح التذكرة'),
  event_reminder: D('Tomorrow: {{event_name}}', 'Hello {{student_name}},\n\nSee you at {{event_name}} on {{event_date}}.\n{{event_place}}',
    'غداً: {{event_name}}', 'مرحباً {{student_name}}،\n\nنراك في {{event_name}} في {{event_date}}.\n{{event_place}}', 'Open my ticket', 'فتح التذكرة'),
  event_follow_up: D('Thank you for joining {{event_name}}', 'Hello {{student_name}},\n\nThank you for attending {{event_name}}. If you would like personal advice, book a free consultation with a counsellor.',
    'شكراً لحضورك {{event_name}}', 'مرحباً {{student_name}}،\n\nشكراً لحضورك {{event_name}}. إذا رغبت باستشارة شخصية، احجز استشارة مجانية مع أحد المستشارين.', 'Book a consultation', 'احجز استشارة'),
  payment_confirmation: D('Payment received — {{amount}}', 'Hello {{student_name}},\n\nWe received your payment of {{amount}} for {{service_name}}. Receipt number: {{invoice_number}}.',
    'تم استلام الدفعة — {{amount}}', 'مرحباً {{student_name}}،\n\nاستلمنا دفعتك بقيمة {{amount}} مقابل {{service_name}}. رقم الإيصال: {{invoice_number}}.', 'View receipt', 'عرض الإيصال'),
  invoice_issued: D('Invoice {{invoice_number}} from {{company_name}}', 'Hello {{student_name}},\n\nPlease find invoice {{invoice_number}} for {{amount}}, due on {{due_date}}.\n\nYou can view, print or save it as PDF from the link below.',
    'الفاتورة {{invoice_number}} من {{company_name}}', 'مرحباً {{student_name}}،\n\nمرفق الفاتورة رقم {{invoice_number}} بقيمة {{amount}}، تاريخ الاستحقاق {{due_date}}.\n\nيمكنك عرضها أو طباعتها أو حفظها بصيغة PDF من الرابط أدناه.', 'View invoice', 'عرض الفاتورة'),
  portal_invite: D('Your {{company_name}} student portal', 'Hello {{student_name}},\n\n{{counsellor_name}} created your student portal. Set your password to follow your applications, upload documents and book appointments.',
    'بوابة الطالب في {{company_name}}', 'مرحباً {{student_name}}،\n\nأنشأ {{counsellor_name}} بوابتك الطلابية. عيّن كلمة المرور لمتابعة طلباتك ورفع المستندات وحجز المواعيد.', 'Set my password', 'تعيين كلمة المرور'),
};

/** Fills {{variables}}; unknown variables are left empty. */
const fill = (text, vars) => String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));

/** The template for `key` in `locale` (`channel` email | sms | whatsapp): the saved version if any, else the default. */
async function get(key, locale = 'en', channel = 'email') {
  let row = null;
  if (await hasTable()) row = await knex('message_templates').where({ key, locale, channel, is_active: true }).first();
  if (row) return { subject: row.subject, body: row.body, cta: row.cta_label, custom: true };
  const def = DEFAULTS[key];
  if (!def) return null;
  const d = def[locale] || def.en;
  return { subject: d.subject, body: d.body, cta: d.cta, custom: false };
}
let tableKnown = null;
async function hasTable() { if (tableKnown === null) tableKnown = await knex.schema.hasTable('message_templates'); return tableKnown; }

async function render(key, locale, vars, channel = 'email') {
  const tpl = await get(key, locale, channel);
  if (!tpl) return null;
  return { subject: fill(tpl.subject, vars), body: fill(tpl.body, vars), cta: tpl.cta ? fill(tpl.cta, vars) : null };
}

const VARIABLES = ['student_name', 'counsellor_name', 'company_name', 'university_name', 'program_name', 'application_status', 'offer_type', 'appointment_type', 'appointment_date',
  'appointment_place', 'document_name', 'due_text', 'reason', 'note', 'visa_status', 'visa_country', 'course_name', 'course_dates', 'registration_status', 'payment_text', 'event_name', 'event_date',
  'event_place', 'amount', 'service_name', 'invoice_number', 'due_date', 'link'];

module.exports = { DEFAULTS, VARIABLES, get, render, fill, resetCache: () => { tableKnown = null; } };
