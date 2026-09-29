const express = require('express');
const { requireAuth, resolveBusiness } = require('../middleware/context');
const site = require('../modules/site/web');

const router = express.Router();
router.use(site.chrome); // header/footer content of the public pages
router.use('/', site);
router.use('/', require('../modules/auth/web'));
router.use('/app', requireAuth, resolveBusiness, require('./app'));
router.use('/admin', require('../modules/admin/web'));
// Clinic pages (docbook/<slug>, /<slug>/login, /<slug>/book…) come LAST so they never shadow a platform path;
// every top-level path the platform uses is also in businesses.RESERVED so no clinic can take it.
router.use('/', require('../modules/site/booking.web'));
router.use('/', require('../modules/site/portal.web'));
module.exports = router;
