// Validation schemas for CRM forms (shared by the staff UI, the JSON API and the public lead forms).
const { z, str, reqStr, optEmail, phone, num, date, list, bool, oneOf, id } = require('../../core/validate');
const ref = require('../catalog/reference');

const iso = () => z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : String(v).toUpperCase()), z.enum(ref.ISO, { errorMap: () => ({ message: 'Choose a valid option.' }) }).optional());
const ym = () => z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().regex(/^\d{4}-\d{2}$/, 'Enter a valid date.').optional());

const leadSchema = z.object({
  first_name: reqStr(80), last_name: str(80), email: optEmail(), phone: phone(), whatsapp: phone(),
  nationality: iso(), residence_country: iso(), city: str(80), preferred_locale: oneOf(['en', 'ar']),
  interest_degree: oneOf(ref.DEGREES), interest_field: str(120), interest_countries: list(10), interest_intake: ym(),
  budget_range: oneOf(ref.BUDGETS.map((b) => b[0])), education_level: oneOf(ref.EDUCATION_LEVELS), english_level: str(60), message: str(4000),
  branch_id: id(), counsellor_id: id(), source: str(40),
}).refine((d) => d.email || d.phone || d.whatsapp, { message: 'Enter an email or a phone number.', path: ['email'] });

const contactSchema = z.object({
  channel: z.enum(['call', 'whatsapp', 'email', 'sms', 'meeting']),
  outcome: z.enum(['reached', 'no_answer', 'left_message', 'replied', 'meeting_held']),
  body: str(4000),
  follow_up_at: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Enter a valid date and time.').optional()),
});

const taskSchema = z.object({
  title: reqStr(190), description: str(4000), assignee_id: id(), priority: oneOf(['low', 'normal', 'high', 'urgent']),
  due_at: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, 'Enter a valid date and time.').optional()),
  recurrence: oneOf(['none', 'daily', 'weekly', 'monthly', 'every_n_days']), recurrence_days: num(1, 365),
  lead_id: id(), student_id: id(), application_id: id(),
});

const studentSections = {
  personal: z.object({
    first_name: reqStr(80), last_name: str(80), email: optEmail(), phone: phone(), whatsapp: phone(), nationality: iso(), residence_country: iso(), city: str(80),
    date_of_birth: date(), gender: oneOf(['female', 'male', 'other', 'undisclosed']), passport: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(20).regex(/^[A-Za-z0-9 -]{5,20}$/, 'Enter a valid passport number.').optional()),
    passport_expiry: date(), preferred_locale: oneOf(['en', 'ar']),
  }),
  academic: z.object({ education_level: oneOf(ref.EDUCATION_LEVELS), institution: str(160), major: str(120), gpa: num(0, 100), gpa_scale: num(1, 100), graduation_date: date() })
    .refine((d) => d.gpa === undefined || d.gpa_scale === undefined || d.gpa <= d.gpa_scale, { message: 'GPA cannot be higher than the scale.', path: ['gpa'] }),
  english: z.object({ ielts_overall: num(0, 9), ielts_min_band: num(0, 9), toefl: num(0, 120), pte: num(10, 90), duolingo: num(10, 160), english_test_date: date() }),
  goals: z.object({ pref_countries: list(10), pref_fields: list(10), pref_degree: oneOf(ref.DEGREES), budget_usd: num(0, 500000), pref_intake: ym(), work_after_study: bool() }),
  history: z.object({ visa_refused: bool(), visa_history: str(4000), work_experience_years: num(0, 60), profile_notes: str(4000) }),
};

/** Turns '' into null for every key the section owns (clearing a field in a form clears it in the database). */
function blanksToNull(section, body, parsed) {
  const keys = Object.keys(studentSections[section].shape || studentSections[section]._def.schema.shape);
  const out = { ...parsed };
  keys.forEach((k) => { if (out[k] === undefined && k in body && k !== 'passport') out[k] = null; });
  return out;
}

module.exports = { leadSchema, contactSchema, taskSchema, studentSections, blanksToNull };
