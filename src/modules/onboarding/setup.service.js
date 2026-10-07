// Owner setup journey (worker: owner): the business rules behind the setup wizard and the home-page checklist.
//
// Steps (each saves on its own and can be revisited any time from the checklist):
//   clinic   → name, specialty, phone / WhatsApp, city & address, logo (+ time zone and currency, prefilled at sign-up)
//   hours    → the clinic's usual week (days + one or two shifts), stored on the clinic and given to every doctor
//   doctors  → quick add (name, specialty, fee, appointment length); "I am the doctor" links the owner's own login
//   services → common services of the clinic's specialty to tick and price; nothing is saved unless ticked
//   team     → reception / nurse / accountant / manager logins through the staff service (temporary password or invitation)
//   booking  → the online booking page: address, on/off, link to share
//   done     → "your clinic is ready" and the first things to do
// Everything written here goes through the existing services (doctors.service, business.service), which audit.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, optionalString, emptyToUndefined, money } = require('../../core/validate');
const { E } = require('../../core/errors');
const businesses = require('../businesses/business.service');
const rbac = require('../rbac/rbac.service');
const doctorsSvc = require('../clinic/doctors.service');
const scheduling = require('../clinic/scheduling');
const options = require('../settings/options');

const STEPS = ['clinic', 'hours', 'doctors', 'services', 'team', 'booking', 'done'];
/** Saved positions from the earlier six-step wizard. */
const LEGACY = { region: 'hours', page: 'booking' };
const stepOf = (saved) => (STEPS.includes(saved) ? saved : LEGACY[saved] || 'clinic');

// Week order as clinics in the region read it (Saturday first).
const WEEK = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const SLOT_CHOICES = [10, 15, 20, 30, 45, 60];
const STAFF_ROLES = ['receptionist', 'nurse', 'accountant', 'clinic_manager', 'doctor'];

// ---------------------------------------------------------------- suggested services by specialty
// Real, common services per specialty. Names only (and a usual length) — the owner types every price, and a
// suggestion is saved only when the owner ticks it.
const S = (key, ar, en, min) => ({ key, ar, en, min });
const COMMON = [S('consult', 'كشفية', 'Consultation', 20), S('followup', 'مراجعة', 'Follow-up visit', 15)];
const CATALOG = {
  general: [...COMMON, S('bp_sugar', 'فحص ضغط وسكري', 'Blood pressure & sugar check', 10), S('injection', 'إعطاء إبرة', 'Injection', 10),
    S('dressing', 'غيار على جرح', 'Wound dressing', 15), S('sutures', 'قطب جرح', 'Wound stitching', 30), S('ecg', 'تخطيط قلب', 'ECG', 15),
    S('report', 'تقرير طبي', 'Medical report', 10)],
  dentistry: [S('consult', 'كشف وفحص أسنان', 'Dental check-up', 15), S('cleaning', 'تنظيف وتلميع', 'Scaling & polishing', 30),
    S('filling', 'حشوة تجميلية', 'Composite filling', 30), S('root_canal', 'علاج عصب', 'Root canal treatment', 60),
    S('extraction', 'خلع سن', 'Tooth extraction', 20), S('surgical', 'خلع جراحي / ضرس عقل', 'Surgical / wisdom tooth extraction', 45),
    S('crown', 'تلبيسة (تاج)', 'Crown', 45), S('whitening', 'تبييض أسنان', 'Teeth whitening', 60), S('xray', 'صورة أشعة للسن', 'Dental X-ray', 10),
    S('fluoride', 'فلورايد للأطفال', 'Fluoride for children', 15)],
  dermatology: [...COMMON, S('laser_hair', 'جلسة ليزر إزالة شعر', 'Laser hair removal session', 30), S('cryo', 'كي بالتبريد (ثآليل)', 'Cryotherapy (warts)', 15),
    S('peel', 'تقشير كيميائي', 'Chemical peel', 30), S('acne', 'جلسة علاج حب الشباب', 'Acne treatment session', 30), S('biopsy', 'خزعة جلدية', 'Skin biopsy', 20)],
  paediatrics: [...COMMON, S('growth', 'فحص نمو وتطور', 'Growth & development check', 20), S('newborn', 'فحص حديثي الولادة', 'Newborn check', 20),
    S('vaccine', 'إعطاء مطعوم', 'Vaccination', 10), S('nebuliser', 'جلسة تبخيرة', 'Nebuliser session', 15)],
  obgyn: [...COMMON, S('pregnancy', 'متابعة حمل مع ألتراساوند', 'Pregnancy follow-up with ultrasound', 20), S('ultrasound', 'تصوير ألتراساوند', 'Ultrasound scan', 15),
    S('pap', 'مسحة عنق الرحم', 'Pap smear', 15), S('iud', 'تركيب لولب', 'IUD insertion', 30)],
  orthopaedics: [...COMMON, S('joint_injection', 'حقنة مفصل', 'Joint injection', 20), S('cast', 'تجبير', 'Cast application', 30),
    S('cast_removal', 'فك جبيرة', 'Cast removal', 15), S('dressing', 'غيار على جرح', 'Wound dressing', 15)],
  ophthalmology: [...COMMON, S('refraction', 'فحص نظر ووصفة نظارة', 'Eye test & glasses prescription', 20), S('pressure', 'قياس ضغط العين', 'Eye pressure test', 10),
    S('fundus', 'فحص قاع العين', 'Fundus examination', 15), S('foreign_body', 'إزالة جسم غريب من العين', 'Foreign body removal', 15)],
  ent: [...COMMON, S('ear_wax', 'تنظيف الأذن', 'Ear wax removal', 15), S('hearing', 'فحص سمع', 'Hearing test', 30), S('endoscopy', 'منظار أنف', 'Nasal endoscopy', 20)],
  cardiology: [...COMMON, S('ecg', 'تخطيط قلب', 'ECG', 15), S('echo', 'إيكو القلب', 'Echocardiogram', 30), S('stress', 'فحص الجهد', 'Exercise stress test', 45),
    S('holter', 'تركيب هولتر 24 ساعة', '24-hour Holter monitor', 15)],
  physiotherapy: [S('assessment', 'جلسة تقييم', 'Assessment session', 45), S('session', 'جلسة علاج طبيعي', 'Physiotherapy session', 45),
    S('dry_needling', 'إبر جافة', 'Dry needling', 30), S('manual', 'جلسة علاج يدوي', 'Manual therapy session', 30)],
  psychiatry: [S('first', 'جلسة تقييم أولى', 'First assessment', 60), S('followup', 'جلسة متابعة', 'Follow-up session', 30),
    S('therapy', 'جلسة علاج نفسي', 'Psychotherapy session', 50)],
  nutrition: [S('first', 'استشارة أولى مع تحليل مكونات الجسم', 'First consultation with body composition', 45), S('followup', 'متابعة ووزن', 'Follow-up & weigh-in', 20),
    S('plan', 'برنامج غذائي', 'Diet plan', 30)],
  cosmetic: [...COMMON, S('botox', 'بوتوكس', 'Botox', 30), S('filler', 'فيلر', 'Filler', 45), S('laser_hair', 'جلسة ليزر إزالة شعر', 'Laser hair removal session', 30),
    S('facial', 'تنظيف بشرة', 'Facial cleansing', 45), S('prp', 'جلسة بلازما (PRP)', 'PRP session', 45)],
};
CATALOG.multi = [...COMMON, S('report', 'تقرير طبي', 'Medical report', 10)];

/** Suggested services for a clinic specialty (general practice when the clinic has none or several). */
const suggestions = (specialty) => require('../specialty/catalogue').pick(specialty, CATALOG) || CATALOG.general; // eslint-disable-line global-require

// ---------------------------------------------------------------- shared helpers
const phone = () => z.preprocess(emptyToUndefined, z.string().trim().max(40).regex(/^[+0-9\s()-]{6,40}$/, 'Enter a valid phone number.').optional());
const timeField = () => z.string({ required_error: 'Enter a valid time.' }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a valid time.');
const toMin = scheduling.timeToMinutes;
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

async function clinicRow(businessId) {
  return knex('businesses').where({ id: businessId }).first('id', 'default_working_hours', 'setup_dismissed_at', 'logo_mime', 'booking_enabled', 'slug', 'phone', 'whatsapp', 'address', 'city', 'specialty');
}

const parseJson = (v) => { if (!v) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

// ---------------------------------------------------------------- logo (sent by the browser as a data: URL)
const LOGO_TYPES = {
  'image/png': (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP',
};
const LOGO_MAX = 1024 * 1024;

function parseLogo(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || '').trim());
  if (!m) throw E.validation({ logo: 'Choose a PNG, JPG or WebP image.' });
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > LOGO_MAX) throw E.validation({ logo: 'The image is larger than 1 MB.' });
  if (!LOGO_TYPES[m[1]](buffer)) throw E.validation({ logo: 'Choose a PNG, JPG or WebP image.' });
  return { buffer, mime: m[1] };
}

// ---------------------------------------------------------------- 1. clinic basics
const clinicSchema = z.object({
  name: z.string({ required_error: 'Enter the clinic name.' }).trim().min(2, 'Enter the clinic name.').max(160),
  name_en: optionalString(160),
  specialty: z.preprocess(emptyToUndefined, z.string().refine((v) => require('../platformops/clinic-types').valid(v), 'Choose a valid value.').optional()),
  phone: phone(), whatsapp: phone(), city: optionalString(100), address: optionalString(255),
  timezone: z.preprocess(emptyToUndefined, z.enum(options.ZONE_IDS, { errorMap: () => ({ message: 'Choose a valid value.' }) }).optional()),
  currency: z.preprocess(emptyToUndefined, z.enum(options.CURRENCIES, { errorMap: () => ({ message: 'Choose a currency.' }) }).optional()),
});

/** Saves the clinic basics (and the logo when one was chosen). Fields left out of the form keep their value. */
async function saveClinic(ctx, input) {
  const d = validate(clinicSchema, input || {});
  let logo = input && input.logo_data ? parseLogo(input.logo_data) : null;
  if (logo) { const small = await require('../../core/imageopt').optimize(logo.buffer, { maxSide: 1200 }); if (small) logo = { buffer: small.buffer, mime: small.mime }; } // eslint-disable-line global-require
  const patch = {
    name: d.name, name_en: d.name_en || null, specialty: d.specialty || null, phone: d.phone || null, whatsapp: d.whatsapp || null,
    city: d.city || null, address: d.address || null,
  };
  if (d.timezone) { patch.timezone = d.timezone; patch.country = options.countryForZone(d.timezone) || null; }
  if (d.currency) patch.currency = d.currency;
  await businesses.updateProfile(ctx, patch);
  if (logo) await businesses.setAppearance(ctx, { logo: logo.buffer, logoMime: logo.mime });
  return { logo: Boolean(logo) };
}

// ---------------------------------------------------------------- 2. working days & hours
const hoursSchema = z.object({
  days: z.preprocess((v) => [].concat(v || []).filter((x) => WEEK.includes(x)), z.array(z.string()).min(1, 'Choose at least one working day.')),
  s1: timeField(), e1: timeField(),
  split: z.preprocess((v) => v === '1' || v === 'on' || v === true, z.boolean()),
  s2: z.preprocess(emptyToUndefined, timeField().optional()), e2: z.preprocess(emptyToUndefined, timeField().optional()),
  apply_doctors: z.preprocess((v) => v === '1' || v === 'on' || v === true, z.boolean()),
});

/** Validates the week form and returns it in doctors.working_hours shape ({ sun: { enabled, shifts, breaks } … }). */
function parseHours(input) {
  if (input && input.hours_layout === 'days') return parseWeekTable(input);
  const d = validate(hoursSchema, input || {});
  if (toMin(d.e1) <= toMin(d.s1)) throw E.validation({ e1: 'The closing time must be after the opening time.' });
  const shifts = [{ start: d.s1, end: d.e1 }];
  if (d.split) {
    if (!d.s2) throw E.validation({ s2: 'Enter a valid time.' });
    if (!d.e2) throw E.validation({ e2: 'Enter a valid time.' });
    if (toMin(d.s2) < toMin(d.e1)) throw E.validation({ s2: 'The second shift must start after the first one ends.' });
    if (toMin(d.e2) <= toMin(d.s2)) throw E.validation({ e2: 'The closing time must be after the opening time.' });
    shifts.push({ start: d.s2, end: d.e2 });
  }
  const week = Object.fromEntries(scheduling.DAY_KEYS.map((k) => [k, d.days.includes(k) ? { enabled: true, shifts: shifts.map((s) => ({ ...s })), breaks: [] } : { enabled: false, shifts: [], breaks: [] }]));
  return { week, applyDoctors: d.apply_doctors };
}

/** "A different time for each day": the per-day table (wh[day][…]); each open day needs a valid first shift. */
function parseWeekTable(input) {
  const src = input.wh || {};
  const week = scheduling.parseWorkingHoursForm(input);
  for (const k of scheduling.DAY_KEYS) {
    const d = src[k] || {};
    if (d.enabled !== '1') continue; // eslint-disable-line no-continue
    const first = week[k].shifts[0];
    if (!first || first.start !== d.s1) throw E.validation({ days: 'Enter the opening and closing time of every open day (closing after opening).' });
    const [a, b] = week[k].shifts;
    if (b && toMin(b.start) < toMin(a.end)) throw E.validation({ days: 'The second shift must start after the first one ends.' });
  }
  if (!scheduling.DAY_KEYS.some((k) => week[k].enabled)) throw E.validation({ days: 'Choose at least one working day.' });
  const applyDoctors = [].concat(input.apply_doctors || []).pop() === '1';
  return { week, applyDoctors };
}

/** Saves the clinic's usual week; with applyDoctors, every doctor of the clinic gets it too. Returns how many doctors changed. */
async function saveHours(ctx, input) {
  const { week, applyDoctors } = parseHours(input);
  const before = await clinicRow(ctx.businessId);
  const json = JSON.stringify(week);
  await knex('businesses').where({ id: ctx.businessId }).update({ default_working_hours: json, updated_at: new Date() });
  businesses.forget(ctx.businessId);
  // Doctors who follow the clinic's week always get it; "apply to every doctor" brings the others back to it too.
  const q = knex('doctors').where({ business_id: ctx.businessId });
  if (!applyDoctors) q.where({ hours_mode: 'clinic' });
  const applied = await q.update({ working_hours: json, hours_mode: 'clinic', updated_at: new Date() });
  await audit.record(ctx, 'clinic.hours_updated', { entityType: 'clinic', entityId: ctx.businessId, oldValues: { hours: parseJson(before.default_working_hours) }, newValues: { hours: week, doctors_updated: applied } });
  return { week, applied };
}

/** The clinic's usual week, or null before it was chosen. */
async function clinicHours(businessId) {
  const row = await clinicRow(businessId);
  return parseJson(row && row.default_working_hours);
}

/** Form values for the week editor from a stored week (or a Sat–Thu 09:00–17:00 starting point). */
function hoursForm(week) {
  if (!week) return { days: WEEK.filter((k) => k !== 'fri'), s1: '09:00', e1: '17:00', split: false, s2: '17:00', e2: '21:00', saved: false, perDay: false, wh: scheduling.defaultWorkingHours() };
  const open = WEEK.filter((k) => week[k] && week[k].enabled);
  const first = open.length ? week[open[0]].shifts : [];
  return {
    days: open, s1: (first[0] || {}).start || '09:00', e1: (first[0] || {}).end || '17:00', split: first.length > 1,
    s2: (first[1] || {}).start || '17:00', e2: (first[1] || {}).end || '21:00', saved: true,
    // Open days that differ from each other (or have a break) can only be shown day by day.
    perDay: open.some((k) => JSON.stringify(week[k].shifts) !== JSON.stringify(first) || (week[k].breaks || []).length > 0),
    wh: week,
  };
}

// ---------------------------------------------------------------- 3. doctors
const doctorSchema = z.object({
  full_name: z.string({ required_error: "Enter the doctor's name." }).trim().min(2, "Enter the doctor's name.").max(190),
  specialization: optionalString(190),
  consultation_fee: money(1e7),
  slot_duration_minutes: z.preprocess((v) => (v === '' || v === undefined ? 30 : Number(v)), z.number().int().refine((n) => SLOT_CHOICES.includes(n), 'Choose a valid value.')),
  is_me: z.preprocess((v) => v === '1' || v === 'on' || v === true, z.boolean()),
});

/**
 * Adds a doctor with the clinic's usual hours. Adding the same name twice (a double click, the back button) is refused
 * instead of creating a second profile. "I am the doctor" links the signed-in owner's login to the new profile.
 */
async function addDoctor(ctx, input) {
  const d = validate(doctorSchema, input || {});
  const same = await knex('doctors').where({ business_id: ctx.businessId }).select('id', 'full_name');
  if (same.some((x) => norm(x.full_name) === norm(d.full_name))) throw E.validation({ full_name: 'This doctor is already added.' });
  let membership = null;
  if (d.is_me) {
    membership = await knex('memberships').where({ business_id: ctx.businessId, user_id: ctx.userId }).first('id', 'doctor_id');
    if (membership && membership.doctor_id) throw E.validation({ is_me: 'Your login is already linked to a doctor profile.' });
  }
  const week = await clinicHours(ctx.businessId);
  const id = await doctorsSvc.saveDoctor(ctx, null, {
    full_name: d.full_name, specialization: d.specialization, consultation_fee: String(d.consultation_fee), slot_duration_minutes: String(d.slot_duration_minutes),
    base_salary: '0', is_active: '1', show_consultation_fee: '1', sort_order: '',
  });
  if (week) await knex('doctors').where({ id, business_id: ctx.businessId }).update({ working_hours: JSON.stringify(week), hours_mode: 'clinic' });
  if (membership) {
    await knex('memberships').where({ id: membership.id }).update({ doctor_id: id, updated_at: new Date() });
    await audit.record(ctx, 'staff.updated', { entityType: 'staff', entityId: ctx.userId, newValues: { doctor_id: id } });
    rbac.invalidate(ctx.businessId);
  }
  return id;
}

const listDoctors = (businessId) => knex('doctors').where({ business_id: businessId }).orderBy('id')
  .select('id', 'full_name', 'specialization', 'consultation_fee', 'slot_duration_minutes', 'is_active');

// ---------------------------------------------------------------- 4. services
const priceOf = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(String(v).replace(/,/g, '').trim()));

/**
 * Saves the ticked suggestions. input.pick = [key…]; input.svc[key] = { name, price, min }. Only ticked rows are read,
 * each needs a price (0 = free). A service whose name the clinic already has is skipped (saving twice adds nothing).
 * Returns { added: [names], skipped: [names] }.
 */
async function saveSuggested(ctx, specialty, input, locale = 'ar') {
  const list = suggestions(specialty);
  const picked = [].concat((input && input.pick) || []).filter((k) => list.some((s) => s.key === k));
  const rows = (input && input.svc) || {};
  if (!picked.length) throw E.validation({ pick: 'Tick at least one service, or add your own below.' });
  const errors = {};
  const clean = picked.map((key) => {
    const cat = list.find((s) => s.key === key);
    const r = rows[key] || {};
    const typed = String(r.name === undefined ? (locale === 'en' ? cat.en : cat.ar) : r.name).trim().replace(/\s+/g, ' ');
    const price = priceOf(r.price);
    const min = Number(r.min || cat.min);
    if (typed.length < 2) errors[`svc.${key}.name`] = 'Enter the service name.';
    if (price === null) errors[`svc.${key}.price`] = 'Enter the price.';
    else if (!Number.isFinite(price) || price < 0) errors[`svc.${key}.price`] = 'Enter a number.';
    else if (price > 1e7) errors[`svc.${key}.price`] = 'Too large.';
    if (![5, 10, 15, 20, 30, 45, 60, 90, 120].includes(min)) errors[`svc.${key}.min`] = 'Choose a valid value.';
    const unchanged = typed === cat.ar || typed === cat.en;
    return { key, name: unchanged ? cat.ar : typed, name_en: unchanged ? cat.en : (locale === 'en' ? typed : null), price, min };
  });
  if (Object.keys(errors).length) throw E.validation(errors);
  const existing = new Set((await knex('services').where({ business_id: ctx.businessId }).select('name', 'name_en')).flatMap((s) => [norm(s.name), norm(s.name_en)]).filter(Boolean));
  const added = []; const skipped = [];
  for (const s of clean) { // eslint-disable-line no-restricted-syntax
    if (existing.has(norm(s.name)) || (s.name_en && existing.has(norm(s.name_en)))) { skipped.push(s.name); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await doctorsSvc.saveService(ctx, null, { name: s.name, name_en: s.name_en || '', price: String(s.price), duration_minutes: String(s.min), is_active: '1', show_price: '1', sort_order: '' });
    existing.add(norm(s.name));
    added.push(s.name);
  }
  return { added, skipped };
}

/** One service typed by the owner (name, price, length). Refused when the clinic already has that name. */
async function addOwnService(ctx, input) {
  const d = validate(z.object({
    name: z.string({ required_error: 'Enter the service name.' }).trim().min(2, 'Enter the service name.').max(190),
    price: z.preprocess((v) => (v === undefined || String(v).trim() === '' ? undefined : v), z.any().refine((v) => v !== undefined, 'Enter the price.')),
  }), input || {});
  const existing = await knex('services').where({ business_id: ctx.businessId }).select('name', 'name_en');
  if (existing.some((s) => norm(s.name) === norm(d.name) || norm(s.name_en) === norm(d.name))) throw E.validation({ name: 'This service is already added.' });
  return doctorsSvc.saveService(ctx, null, { name: d.name, price: input.price, duration_minutes: input.duration_minutes || '30', doctor_id: input.doctor_id, is_active: '1', show_price: '1', sort_order: '' });
}

const listServices = (businessId) => knex('services').where({ business_id: businessId }).orderBy('id').select('id', 'name', 'name_en', 'price', 'duration_minutes', 'is_active');

// ---------------------------------------------------------------- 5. staff logins
/** Roles offered in the wizard (system roles only, in this order), as { id, key }. */
async function staffRoles(businessId) {
  const roles = await knex('roles').where({ business_id: businessId, is_system: true }).whereIn('key', STAFF_ROLES).select('id', 'key');
  return STAFF_ROLES.map((k) => roles.find((r) => r.key === k)).filter(Boolean);
}

/**
 * Checks a staff login before it goes to the staff service: a wizard role, a sign-in e-mail, and not someone who
 * already has a login here or a pending invitation (so pressing the button twice never invites twice).
 */
async function checkStaff(ctx, input) {
  const roles = await staffRoles(ctx.businessId);
  const role = roles.find((r) => String(r.id) === String(input && input.role_id));
  if (!role) throw E.validation({ role_id: 'Choose a valid role.' });
  const email = String((input && input.email) || '').trim().toLowerCase();
  if (email) {
    const member = await knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.business_id': ctx.businessId, 'u.email': email }).first('m.id');
    if (member) throw E.validation({ email: 'This person already has a login at this clinic.' });
    const invited = await knex('invitations').where({ business_id: ctx.businessId, email }).whereNull('accepted_at').whereNull('revoked_at').where('expires_at', '>', new Date()).first('id');
    if (invited) throw E.validation({ email: 'An invitation was already sent to this e-mail.' });
  }
  return role;
}

// ---------------------------------------------------------------- 6. booking page
async function saveBooking(ctx, business, input) {
  const slug = String((input && input.slug) || '').trim();
  if (slug && slug !== business.slug) await businesses.setSlug(ctx, slug);
  else if (!slug && !business.slug) throw E.validation({ slug: 'Use 3–40 English letters, numbers or dashes.' });
  await businesses.updateProfile(ctx, { booking_enabled: input && (input.booking_enabled === '1' || input.booking_enabled === 'on') });
}

// ---------------------------------------------------------------- progress
async function advance(businessId, saved, step) {
  const n = STEPS[STEPS.indexOf(step) + 1];
  // Never move the saved position backwards when someone revisits an earlier step.
  if (n && STEPS.indexOf(n) > STEPS.indexOf(stepOf(saved))) await businesses.setOnboarding(businessId, n, n === 'done');
  return n || 'done';
}

async function complete(ctx) {
  const b = await knex('businesses').where({ id: ctx.businessId }).first('onboarding_completed_at');
  if (b && b.onboarding_completed_at) { await businesses.setOnboarding(ctx.businessId, 'done'); return false; }
  await businesses.setOnboarding(ctx.businessId, 'done', true);
  await audit.record(ctx, 'clinic.setup_completed', { entityType: 'clinic', entityId: ctx.businessId });
  return true;
}

// ---------------------------------------------------------------- home-page checklist
/**
 * What is still missing for a clinic to run smoothly: [{ key, done, href }] + percent. Links go back into the wizard.
 * Hidden once everything is done or the owner dismissed it.
 */
async function checklist(businessId) {
  const [b, doctors, services, members, invites, appts] = await Promise.all([
    clinicRow(businessId),
    knex('doctors').where({ business_id: businessId, is_active: true }).count({ n: '*' }).first(),
    knex('services').where({ business_id: businessId, is_active: true }).count({ n: '*' }).first(),
    knex('memberships').where({ business_id: businessId, status: 'active' }).count({ n: '*' }).first(),
    knex('invitations').where({ business_id: businessId }).whereNull('accepted_at').whereNull('revoked_at').count({ n: '*' }).first(),
    knex('appointments').where({ business_id: businessId }).whereNot('appointment_type', 'blocked').count({ n: '*' }).first(),
  ]);
  const items = [
    { key: 'clinic', done: Boolean(b.phone && (b.address || b.city)), href: '/app/onboarding/clinic' },
    { key: 'logo', done: Boolean(b.logo_mime), href: '/app/onboarding/clinic#logo' },
    { key: 'hours', done: Boolean(b.default_working_hours), href: '/app/onboarding/hours' },
    { key: 'doctors', done: Number(doctors.n) > 0, href: '/app/onboarding/doctors' },
    { key: 'services', done: Number(services.n) > 0, href: '/app/onboarding/services' },
    { key: 'team', done: Number(members.n) > 1 || Number(invites.n) > 0, href: '/app/onboarding/team' },
    { key: 'booking', done: Boolean(b.booking_enabled && b.slug), href: '/app/onboarding/booking' },
    { key: 'first_appointment', done: Number(appts.n) > 0, href: '/app/appointments/new' },
  ];
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length, percent: Math.round((done * 100) / items.length), dismissed: Boolean(b.setup_dismissed_at), complete: done === items.length };
}

async function dismissChecklist(ctx) {
  await knex('businesses').where({ id: ctx.businessId }).update({ setup_dismissed_at: new Date() });
  await audit.record(ctx, 'clinic.setup_checklist_hidden', { entityType: 'clinic', entityId: ctx.businessId });
}

module.exports = {
  STEPS, WEEK, SLOT_CHOICES, STAFF_ROLES, CATALOG, stepOf, suggestions, parseLogo, saveClinic, parseHours, saveHours, clinicHours, hoursForm,
  addDoctor, listDoctors, saveSuggested, addOwnService, listServices, staffRoles, checkStaff, saveBooking, advance, complete, checklist, dismissChecklist,
};
