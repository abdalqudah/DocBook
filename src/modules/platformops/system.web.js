// The clinic's Settings → System (only for the installation's own account, users.is_platform_admin): update the
// system from the update file, edit the sign-in page. Everyone else gets "page not found".
const express = require('express');
const { E } = require('../../core/errors');

const router = express.Router();
router.use(['/system-update', '/login-page'], (req, res, next) => (req.user && req.user.is_platform_admin ? next() : next(E.notFound('Page'))));
require('./updates.web').mount(router, { path: '/system-update', base: '/app/settings/system-update', layout: 'app' });
require('./loginpage.web').mount(router, { path: '/login-page', base: '/app/settings/login-page', layout: 'app' });

module.exports = router;
