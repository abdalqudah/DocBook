// Form runner for the setup wizard: like settings/form, but the wizard's own validation messages
// (ownerx.json → errors_ownerx.vmsg) are tried first, then the admin-area and shared tables.
const { AppError } = require('../../core/errors');
const { dictionaries } = require('../../core/i18n');
const { wrap } = require('../../routes/helpers');
const settingsForm = require('../settings/form');

function message(locale, text) {
  const own = ((dictionaries[locale] || {}).errors_ownerx || {}).vmsg || {};
  return own[text] || settingsForm.message(locale, text);
}

const form = (action, rerender) => wrap(async (req, res, next) => {
  try {
    await action(req, res, next);
  } catch (err) {
    if (err instanceof AppError && [402, 404, 409, 422, 429, 502].includes(err.status) && rerender) {
      res.status(err.status);
      return rerender(req, res, {
        errors: err.details && err.code === 'VALIDATION_FAILED' ? Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k, message(req.locale, v)])) : {},
        formError: { code: err.code, message: settingsForm.codeText(req, err), details: err.details },
        old: req.body,
      });
    }
    throw err;
  }
});

module.exports = { form, message };
