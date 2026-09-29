// /app/messaging: staff helpers.
//   GET /app/messaging/wa/<appointment id>?kind=reminder|confirmation|review
//     opens WhatsApp (wa.me click-to-chat) with the ready-made message and the patient's /r/ (or /review/) link,
//     for the member to send from their own WhatsApp — nothing is sent automatically from here.
const express = require('express');
const { wrap, flash, back } = require('../../routes/helpers');
const { canAny } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { publicBase } = require('../../middleware/web');
const msg = require('./messaging.service');
const { errText } = require('./pages');

const router = express.Router();

router.get('/wa/:id(\\d+)', canAny('appointments.manage', 'frontdesk.use'), wrap(async (req, res) => {
  try {
    const kind = ['confirmation', 'reminder', 'review'].includes(req.query.kind) ? req.query.kind : 'reminder';
    const { href } = await msg.clickToChat({ ...req.ctx, msgLocale: ['ar', 'en'].includes(req.query.lang_msg) ? req.query.lang_msg : null }, Number(req.params.id), kind, publicBase(req));
    return res.redirect(href);
  } catch (err) {
    if (!(err instanceof AppError) || err.status === 404) throw err;
    flash(req, 'error', errText(req, err));
    return back(req, res, `/app/appointments/${Number(req.params.id)}`);
  }
}));

module.exports = router;
