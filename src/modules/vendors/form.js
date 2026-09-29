// Form runner for the vendor pages (same contract as routes/helpers.form): expected business errors re-render
// the form. Field messages are translated from errors_vendors.vmsg first, then the shared vmsg table; error
// codes from errors_vendors.<CODE>, then errors.<CODE>.
const { AppError } = require('../../core/errors');
const { dictionaries, translateMessage } = require('../../core/i18n');
const { wrap } = require('../../routes/helpers');

function message(locale, text) {
  const own = ((dictionaries[locale] || {}).errors_vendors || {}).vmsg || {};
  if (own[text]) return own[text];
  if (locale === 'en') return text;
  return translateMessage(locale, text);
}

function codeText(req, err) {
  for (const key of [`errors_vendors.${err.code}`, `errors.${err.code}`]) {
    const s = req.t(key);
    if (s !== key) return s;
  }
  return err.message;
}

const fieldErrors = (req, err) => (err.details && err.code === 'VALIDATION_FAILED'
  ? Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k.split('.')[0], message(req.locale, v)])) : {});

const form = (action, rerender) => wrap(async (req, res, next) => {
  try {
    await action(req, res, next);
  } catch (err) {
    if (err instanceof AppError && [404, 409, 422, 429].includes(err.status) && rerender) {
      res.status(err.status);
      return rerender(req, res, { errors: fieldErrors(req, err), formError: { code: err.code, message: codeText(req, err), details: err.details }, old: req.body || {} });
    }
    throw err;
  }
});

module.exports = { form, message, codeText, fieldErrors };
