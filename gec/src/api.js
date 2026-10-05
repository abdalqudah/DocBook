// JSON API (/api/*): same services, validation and permission checks as the pages. Session-authenticated; every
// write needs the X-CSRF-Token header. Errors: { ok: false, error: { code, message, details } }.
const express = require('express');
const limits = require('./middleware/limits');

const router = express.Router();
router.use(limits.api);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use('/leads', require('./modules/crm/api'));
router.use('/applications', require('./modules/admissions/api'));
module.exports = router;
