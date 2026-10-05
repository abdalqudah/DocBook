// Every route of the application, by area.
const express = require('express');

const router = express.Router();
router.use('/api', require('./api'));
router.use('/', require('./modules/auth/web'));
router.use('/staff', require('./modules/staff/web'));
router.use('/', require('./modules/site/leads.web'));
router.use('/', require('./modules/site/web'));
module.exports = router;
