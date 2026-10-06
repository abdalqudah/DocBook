// Every route of the application, by area.
const express = require('express');
const tracking = require('./modules/growth/tracking');

const router = express.Router();
router.use('/api', require('./api'));
router.use('/', require('./modules/auth/web'));
router.use('/staff', require('./modules/staff/web'));
router.use(tracking.visitor); // req.visitor for consenting visitors on public pages
router.use('/', tracking.router);
router.use('/', require('./modules/growth/site.web'));
router.use('/', require('./modules/site/leads.web'));
router.use('/', require('./modules/catalog/site.web'));
router.use('/', require('./modules/booking/site.web'));
router.use('/', require('./modules/finance/site.web'));
router.use('/', require('./modules/site/web'));
module.exports = router;
