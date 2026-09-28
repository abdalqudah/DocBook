const { z } = require('zod');
const { E } = require('./errors');

// Parses input with a zod schema and throws a VALIDATION_FAILED AppError with per-field messages.
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

// Treat empty strings (HTML forms) and null (API clients) as "not provided".
const emptyToUndefined = (v) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v);
const optionalString = (max = 255) => z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());
const optionalId = () => z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional());
const email = () => z.string().trim().toLowerCase().email('Enter a valid email address.').max(190);
const password = () => z.string().min(8, 'Password must be at least 8 characters.').max(128);
const money = (max = 1e12) => z.preprocess((v) => (v === '' || v === null || v === undefined ? 0 : Number(String(v).replace(/,/g, ''))), z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.').max(max, 'Too large.'));
const isoDate = () => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.');
const monthKey = () => z.string().trim().regex(/^\d{4}-\d{2}$/, 'Enter a valid month.');

module.exports = { z, validate, optionalString, optionalId, email, password, money, isoDate, monthKey, emptyToUndefined };
