// One error type for expected failures; the error middleware turns it into a page or a JSON answer.
class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const E = {
  validation: (details, message = 'Some fields are invalid.') => new AppError('VALIDATION_FAILED', message, 422, details),
  unauthenticated: () => new AppError('UNAUTHENTICATED', 'Please sign in to continue.', 401),
  invalidCredentials: () => new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401),
  locked: (minutes) => new AppError('ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${minutes} minutes.`, 429, { minutes }),
  disabled: () => new AppError('ACCOUNT_DISABLED', 'This account is disabled. Contact your administrator.', 403),
  forbidden: (permission) => new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.', 403, permission ? { permission } : undefined),
  notFound: (entity = 'Record') => new AppError('NOT_FOUND', `${entity} not found.`, 404),
  conflict: (code, message, details) => new AppError(code, message, 409, details),
  csrf: () => new AppError('CSRF_TOKEN_INVALID', 'Your session expired. Refresh the page and try again.', 419),
  rateLimited: () => new AppError('RATE_LIMITED', 'Too many requests. Please try again later.', 429),
  notConfigured: (what) => new AppError('NOT_CONFIGURED', `${what} is not connected yet. An administrator can connect it in Settings → Integrations.`, 409, { integration: what }),
};

module.exports = { AppError, E };
