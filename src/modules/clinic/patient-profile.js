// The fuller patient file (beyond name, phone and the medical basics): the clinic's own file number, English name,
// second phone, address, nationality and residence, work, marital status, blood group, profile category, case
// manager, how they heard of the clinic, a standing discount, the important note (shown on the file, on the visit and
// when booking), current medicines, smoking and alcohol, pregnancy and contraceptive pills (women), appointment
// reminders, groups, and the photo. Every field is optional; a form that does not carry `profile_form=1` leaves them.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');

const CATEGORIES = ['standard', 'vip', 'staff', 'family', 'corporate', 'charity'];
const MARITAL = ['single', 'married', 'divorced', 'widowed'];
const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const REFERRAL = ['google', 'instagram', 'facebook', 'tiktok', 'snapchat', 'whatsapp', 'friend', 'doctor', 'website', 'signboard', 'insurance', 'event', 'other'];
const HABIT = ['no', 'yes', 'former'];
const PREGNANT = ['no', 'yes', 'unknown'];
const YES_NO = ['no', 'yes'];
// Nationality / residence: the region first, then common others (names come from Intl in the page's language).
const COUNTRIES = ['JO', 'PS', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'IQ', 'SY', 'LB', 'EG', 'YE', 'SD', 'LY', 'TN', 'DZ', 'MA', 'TR', 'IR',
  'PK', 'IN', 'BD', 'PH', 'ID', 'LK', 'NP', 'ET', 'SO', 'NG', 'KE', 'GB', 'US', 'CA', 'DE', 'FR', 'IT', 'ES', 'SE', 'NL', 'RU', 'UA',
  'CN', 'AU', 'BR'];
const FILE_NO = /^[A-Za-z0-9][A-Za-z0-9\-/.]{0,29}$/;

const pick = (list) => z.preprocess(emptyToUndefined, z.enum(list, { errorMap: () => ({ message: 'Choose a valid value.' }) }).optional());
const schema = z.object({
  file_number: z.preprocess(emptyToUndefined, z.string().trim().regex(FILE_NO, 'Use letters, digits and dashes only.').optional()),
  name_en: optionalString(190), phone2: optionalString(40), address: optionalString(255), city: optionalString(100), area: optionalString(100),
  nationality: pick(COUNTRIES), residence: pick(COUNTRIES), occupation: optionalString(120), marital_status: pick(MARITAL), blood_group: pick(BLOOD),
  category: pick(CATEGORIES), referral_source: pick(REFERRAL), referral_detail: optionalString(190),
  case_manager_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  discount_percent: z.preprocess((v) => (v === '' || v === undefined || v === null ? undefined : Number(String(v).replace(/[٫,]/g, '.'))),
    z.number({ invalid_type_error: 'Enter a number.' }).min(0, 'Must be between 0 and 100.').max(100, 'Must be between 0 and 100.').optional()),
  important_note: optionalString(1000), current_medications: optionalString(3000),
  smoker: pick(HABIT), alcohol: pick(HABIT), pregnant: pick(PREGNANT), contraceptive: pick(YES_NO),
});
const FIELDS = Object.keys(schema.shape);

/** The profile columns from a submitted form → a row patch (only when the form carries the profile). */
async function patchOf(ctx, input, pid = null) {
  if (!input || input.profile_form !== '1') return null;
  const d = validate(schema, input);
  const row = Object.fromEntries(FIELDS.map((k) => [k, d[k] === undefined ? null : d[k]]));
  row.important_on_booking = ['1', 'on', true].includes(input.important_on_booking) && Boolean(row.important_note);
  if (row.case_manager_id && !(await knex('memberships').where({ business_id: ctx.businessId, user_id: row.case_manager_id }).first('user_id'))) {
    throw E.validation({ case_manager_id: 'Choose a valid value.' });
  }
  if (row.file_number) {
    const clash = await knex('patients').where({ business_id: ctx.businessId, file_number: row.file_number }).modify((q) => { if (pid) q.whereNot({ id: pid }); }).first('id');
    if (clash) throw new AppError('PATIENT_FILE_NUMBER_TAKEN', 'Another patient has this file number.', 409, { file_number: 'Another patient has this file number.' });
  }
  if (input.reminders_form === '1') {
    const off = !['1', 'on', true].includes(input.reminders);
    row.messaging_opt_out = off;
    if (off) row.messaging_opt_out_at = new Date();
  }
  row.updated_by = ctx.userId || null;
  return row;
}

/** The highest numeric file number of the clinic (the form shows it; a new patient without one gets the next). */
async function lastFileNumber(businessId) {
  const r = await knex('patients').where({ business_id: businessId }).whereRaw("file_number REGEXP '^[0-9]{1,12}$'").max({ n: knex.raw('CAST(file_number AS UNSIGNED)') }).first();
  return r && r.n ? Number(r.n) : 0;
}

/** Gives a new patient the next file number when none was typed (retries once if another desk took it). */
async function assignFileNumber(ctx, pid) {
  for (let i = 0; i < 3; i += 1) {
    const next = String((await lastFileNumber(ctx.businessId)) + 1); // eslint-disable-line no-await-in-loop
    try {
      await knex('patients').where({ id: pid, business_id: ctx.businessId }).whereNull('file_number').update({ file_number: next }); // eslint-disable-line no-await-in-loop
      return next;
    } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
  }
  return null;
}

// ---------------------------------------------------------------- groups
const groups = (businessId) => knex('patient_groups').where({ business_id: businessId }).orderBy('name').select('id', 'name');
const groupsOf = (businessId, pid) => knex('patient_group_members as m').join('patient_groups as g', 'g.id', 'm.group_id')
  .where({ 'm.business_id': businessId, 'm.patient_id': pid }).orderBy('g.name').select('g.id', 'g.name');

/** Sets the patient's groups from the form: chosen ids of this clinic, plus a new group typed by name. */
async function setGroups(ctx, pid, input) {
  if (!input || input.groups_form !== '1') return;
  const own = new Set((await groups(ctx.businessId)).map((g) => g.id));
  const ids = [...new Set([].concat(input.groups || []).map(Number).filter((n) => own.has(n)))];
  const fresh = String(input.new_group || '').replace(/[\u0000-\u001F<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (fresh) {
    const hit = await knex('patient_groups').where({ business_id: ctx.businessId, name: fresh }).first('id');
    ids.push(hit ? hit.id : (await knex('patient_groups').insert({ business_id: ctx.businessId, name: fresh }))[0]);
  }
  const before = (await groupsOf(ctx.businessId, pid)).map((g) => g.id).sort((a, b) => a - b);
  const after = [...new Set(ids)].sort((a, b) => a - b);
  if (before.join() === after.join()) return;
  await knex.transaction(async (trx) => {
    await trx('patient_group_members').where({ business_id: ctx.businessId, patient_id: pid }).del();
    if (after.length) await trx('patient_group_members').insert(after.map((g) => ({ business_id: ctx.businessId, patient_id: pid, group_id: g })));
  });
  await audit.record(ctx, 'patient.groups_changed', { entityType: 'patient', entityId: pid, oldValues: { groups: before }, newValues: { groups: after } });
}

// ---------------------------------------------------------------- photo
const PHOTO_MAX = 3 * 1024 * 1024;
function sniffImage(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
async function setPhoto(ctx, pid, file) {
  if (!file || !file.buffer || !file.size) throw new AppError('FILE_REQUIRED', 'Choose a photo.', 422, { photo: 'Choose a photo.' });
  if (file.buffer.length > PHOTO_MAX) throw new AppError('FILE_TOO_BIG', 'The photo is too large (3 MB at most).', 422, { photo: 'The photo is too large (3 MB at most).' });
  const mime = sniffImage(file.buffer);
  if (!mime) throw new AppError('FILE_TYPE', 'Use a JPG, PNG or WebP photo.', 422, { photo: 'Use a JPG, PNG or WebP photo.' });
  await require('../storage/storage.service').assertRoom(ctx.businessId, file.buffer.length); // eslint-disable-line global-require
  const row = { patient_id: pid, business_id: ctx.businessId, mime, size: file.buffer.length, data: file.buffer, created_by: ctx.userId || null };
  await knex('patient_photos').insert(row).onConflict('patient_id').merge({ mime, size: row.size, data: row.data, created_by: row.created_by, updated_at: new Date() });
  await audit.record(ctx, 'patient.photo_set', { entityType: 'patient', entityId: pid, newValues: { size: row.size, mime } });
}
async function removePhoto(ctx, pid) {
  const n = await knex('patient_photos').where({ patient_id: pid, business_id: ctx.businessId }).del();
  if (n) await audit.record(ctx, 'patient.photo_removed', { entityType: 'patient', entityId: pid });
}
const photoOf = (businessId, pid) => knex('patient_photos').where({ patient_id: pid, business_id: businessId }).first('mime', 'data', 'updated_at');
const hasPhoto = async (businessId, pid) => Boolean(await knex('patient_photos').where({ patient_id: pid, business_id: businessId }).first('patient_id', 'updated_at'));

/** Choices for the form (labels from the page's translations; countries from Intl). */
function choices(t, locale) {
  const region = (c) => { try { return new Intl.DisplayNames([locale], { type: 'region' }).of(c) || c; } catch { return c; } };
  return {
    categories: CATEGORIES.map((k) => ({ value: k, label: t(`pprofile.categories.${k}`) })),
    marital: MARITAL.map((k) => ({ value: k, label: t(`pprofile.marital.${k}`) })),
    blood: BLOOD.map((k) => ({ value: k, label: k })),
    referral: REFERRAL.map((k) => ({ value: k, label: t(`pprofile.referral.${k}`) })),
    habit: HABIT.map((k) => ({ value: k, label: t(`pprofile.habit.${k}`) })),
    pregnant: PREGNANT.map((k) => ({ value: k, label: t(`pprofile.pregnant_opts.${k}`) })),
    yesNo: YES_NO.map((k) => ({ value: k, label: t(`pprofile.yes_no.${k}`) })),
    countries: COUNTRIES.map((c) => ({ value: c, label: region(c) })),
  };
}

/** Members who can be a case manager (the clinic's team). */
const managers = (businessId) => knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where('m.business_id', businessId).orderBy('u.name').select('u.id', 'u.name');

module.exports = {
  CATEGORIES, MARITAL, BLOOD, REFERRAL, HABIT, PREGNANT, YES_NO, COUNTRIES, FIELDS,
  patchOf, lastFileNumber, assignFileNumber, groups, groupsOf, setGroups, setPhoto, removePhoto, photoOf, hasPhoto, choices, managers, sniffImage,
};
