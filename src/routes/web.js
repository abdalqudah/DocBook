const express = require('express');
const { requireAuth, resolveBusiness } = require('../middleware/context');

const router = express.Router();
router.use('/', require('../modules/site/web'));
router.use('/', require('../modules/auth/web'));
router.use('/app', requireAuth, resolveBusiness, require('./app'));
module.exports = router;
