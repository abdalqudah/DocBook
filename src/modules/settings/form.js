// Form runner for the settings, onboarding and sign-in screens. Same contract as routes/helpers.form, plus the
// admin-area validation messages (settings.json → errors_admin.vmsg) and error codes (errors_admin.<CODE>).
const { AppError } = require('../../core/errors');
const { dictionaries, translateMessage } = require('../../core/i18n');
const { wrap } = require('../../routes/helpers');

function message(locale, text) {
  const own = ((dictionaries[locale] || {}).errors_admin || {}).vmsg || {};
  if (own[text]) return own[text];
  if (locale === 'en') return text;
  return translateMessage(locale, text);
}

function codeText(req, err) {
  for (const key of [`errors_admin.${err.code}`, `errors.${err.code}`]) {
    const s = req.t(key);
    if (s !== key) return s;
  }
  return err.message;
}

const form = (action, rerender) => wrap(async (req, res, next) => {
  try {
    await action(req, res, next);
  } catch (err) {
    if (err instanceof AppError && [402, 403, 404, 409, 422, 429, 502].includes(err.status) && rerender && !(err.status === 403 && err.code === 'PERMISSION_DENIED')) {
      res.status(err.status);
      return rerender(req, res, {
        errors: err.details && err.code === 'VALIDATION_FAILED' ? Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k, message(req.locale, v)])) : {},
        formError: { code: err.code, message: codeText(req, err), details: err.details },
        old: req.body,
      });
    }
    throw err;
  }
});

module.exports = { form, message, codeText };
