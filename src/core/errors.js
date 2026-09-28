// Stable, machine-readable error codes shared by the web UI and the JSON endpoints.
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
  forbidden: (permission) => new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.', 403, permission ? { permission } : undefined),
  noBusiness: () => new AppError('BUSINESS_REQUIRED', 'Select a workspace to continue.', 403),
  notFound: (entity = 'Record') => new AppError('NOT_FOUND', `${entity} not found.`, 404),
  conflict: (code, message) => new AppError(code, message, 409),
  csrf: () => new AppError('CSRF_TOKEN_INVALID', 'Your session expired. Refresh the page and try again.', 419),
  rateLimited: () => new AppError('RATE_LIMITED', 'Too many requests. Please try again later.', 429),
};

module.exports = { AppError, E };
