// Provider webhooks (WhatsApp, SMS, payment gateways). Each provider adapter verifies its own signature.
const express = require('express');

const router = express.Router();
router.use(express.raw({ type: '*/*', limit: '1mb' }));
module.exports = router;
