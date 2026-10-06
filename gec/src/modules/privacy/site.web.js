// Public privacy request form (on /privacy) and the portal's "delete my data" request.
const express = require('express');
const limits = require('../../middleware/limits');
const { flash } = require('../../middleware/web');
const { ah } = require('../../core/http');
const { validate, z, reqStr, str, email } = require('../../core/validate');
const capture = require('../site/capture');
const svc = require('./service');

const router = express.Router();
router.post('/privacy/request', limits.publicForm, ah(async (req, res) => {
  if (capture.isBot(req)) return res.redirect('/privacy?sent=1#request');
  try {
    const d = validate(z.object({ name: reqStr(160), email: email(), type: z.enum(['export', 'delete', 'correct', 'other']), details: str(4000) }), req.body);
    const student = req.user && req.user.kind === 'student' ? await require('../portal/account').studentOf(req) : null; // eslint-disable-line global-require
    await svc.createRequest({ userId: req.user ? req.user.id : null, ip: req.ip }, { ...d, studentId: student ? student.id : null, userId: req.user ? req.user.id : null, verified: !!(student && student.email === d.email) });
    return res.redirect('/privacy?sent=1#request');
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    flash(req, 'error', Object.values(e.details || {}).join(' '));
    return res.redirect('/privacy#request');
  }
}));
module.exports = router;
