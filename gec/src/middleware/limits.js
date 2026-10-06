// Rate limits (per IP, in memory: one app process). Behind several processes use a shared store.
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { E } = require('../core/errors');

const make = (windowMs, limit) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  skip: () => config.isTest && !process.env.TEST_RATE_LIMITS,
  handler: (req, res, next) => next(E.rateLimited()),
});

module.exports = {
  login: make(15 * 60_000, 20), // sign-in attempts per IP (accounts also lock after 5 wrong passwords)
  reset: make(15 * 60_000, 6),
  register: make(60 * 60_000, 10),
  publicForm: make(10 * 60_000, 12), // consultation / contact / event forms
  tracking: make(60_000, 120),
  advisor: make(10 * 60_000, 30), // AI advisor questions
  api: make(60_000, 300),
};
