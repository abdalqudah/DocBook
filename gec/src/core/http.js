// Express helpers: async handlers, pagination params, JSON answers.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const page = (req) => Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
const ok = (res, data = {}, status = 200) => res.status(status).json({ ok: true, ...data });
/** Integer id from a route parameter, or a 404. */
const idParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) { const { E } = require('./errors'); throw E.notFound(); } return n; }; // eslint-disable-line global-require
module.exports = { ah, page, ok, idParam };
