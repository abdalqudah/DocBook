const express = require('express');

const router = express.Router();
router.get('/', (req, res) => (req.user ? res.redirect('/app') : res.redirect('/login')));
module.exports = router;
