const express = require('express');

const router = express.Router();
router.get('/', (req, res) => res.page('pages/error', { title: 'Dashboard', status: 200, code: 'OK', message: 'Shell OK', stack: null }));
module.exports = router;
