// zod helpers: parse input or throw VALIDATION_FAILED with one message per field.
const { z } = require('zod');
const { E } = require('./errors');

function validate(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!details[key]) details[key] = issue.message;
  }
  throw E.validation(details);
}

// HTML forms send '' for "nothing"; API clients send null. Both mean "not provided".
const blank = (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v);
const str = (max = 255) => z.preprocess(blank, z.string().trim().max(max, 'Too long.').optional());
const reqStr = (max = 255) => z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(max, 'Too long.');
const id = () => z.preprocess(blank, z.coerce.number().int().positive().optional());
const reqId = () => z.coerce.number({ invalid_type_error: 'Required.' }).int().positive('Required.');
const email = () => z.string().trim().toLowerCase().email('Enter a valid email address.').max(190);
const optEmail = () => z.preprocess(blank, email().optional());
const password = () => z.string().min(10, 'Use at least 10 characters.').max(128, 'Too long.')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Use letters and numbers.');
const phone = () => z.preprocess(blank, z.string().trim().max(40).regex(/^[+\d][\d\s().-]{5,}$/, 'Enter a valid phone number.').optional());
const num = (min = 0, max = 1e12) => z.preprocess((v) => (blank(v) === undefined ? undefined : Number(String(v).replace(/,/g, ''))),
  z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(min, 'Too small.').max(max, 'Too large.').optional());
const date = () => z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.').optional());
const dateTime = () => z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/, 'Enter a valid date and time.').optional());
const bool = () => z.preprocess((v) => v === true || v === 'true' || v === '1' || v === 'on' || v === 1, z.boolean());
const oneOf = (values) => z.preprocess(blank, z.enum(values, { errorMap: () => ({ message: 'Choose a valid option.' }) }).optional());
const list = (max = 50) => z.preprocess((v) => {
  if (blank(v) === undefined) return [];
  if (Array.isArray(v)) return v.filter((x) => blank(x) !== undefined).map(String);
  return String(v).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}, z.array(z.string().max(120)).max(max));

module.exports = { z, validate, blank, str, reqStr, id, reqId, email, optEmail, password, phone, num, date, dateTime, bool, oneOf, list };
