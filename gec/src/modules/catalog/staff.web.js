// Catalogue inside the CRM: a student's program matches and shortlist (tabs on the student page), and personalised
// cost estimates a counsellor prepares and sends.
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah, idParam } = require('../../core/http');
const tabs = require('../crm/tabs');
const students = require('../crm/students.service');
const activity = require('../crm/activity.service');
const matching = require('./matching.service');
const shortlist = require('./shortlist.service');
const calculator = require('./calculator');
const money = require('./money');
const email = require('../comms/email');
const { translator } = require('../../core/i18n');

tabs.add({ key: 'matches', icon: 'target', perms: ['students.view'], order: 20, view: 'pages/staff/catalog/tab-matches',
  load: async (req, s) => ({ matches: await matching.forStudent(s.id, { limit: 25 }), saved: await shortlist.ids({ studentId: s.id }), s }) });
tabs.add({ key: 'shortlist', icon: 'bookmark', perms: ['students.view'], order: 21, view: 'pages/staff/catalog/tab-shortlist',
  load: async (req, s) => ({ items: await shortlist.items({ studentId: s.id }), s,
    estimates: await knex('cost_estimates').where({ student_id: s.id }).orderBy('created_at', 'desc').limit(10),
    dests: await knex('destinations').where({ is_active: true }).orderBy('position'), currencies: await money.codes() }) });

const router = express.Router();

router.post('/students/:id/shortlist', can('students.manage'), ah(async (req, res) => {
  const s = await students.get(req.staff, idParam(req.params.id));
  const on = await shortlist.toggle({ studentId: s.id }, String(req.body.type || 'program'), Number(req.body.item_id), { addedBy: req.user.id, on: req.body.on === undefined ? undefined : req.body.on === '1' });
  if (on) await activity.log({ studentId: s.id }, { type: 'shortlist', title: 'shortlist_added', meta: { type: req.body.type || 'program', id: Number(req.body.item_id), name: req.body.name || null }, actorId: req.user.id, shareable: true });
  flash(req, 'ok', on ? req.t('shortlist.added') : req.t('shortlist.removed'));
  res.redirect(`/staff/students/${s.id}?tab=${req.body.back === 'matches' ? 'matches' : 'shortlist'}`);
}));

// Personalised cost estimate: calculated, saved with a private link, optionally e-mailed to the student.
router.post('/students/:id/estimates', can('students.manage'), ah(async (req, res) => {
  const s = await students.get(req.staff, idParam(req.params.id));
  const input = { destinations: [].concat(req.body.d || []).slice(0, 3), currency: /^[A-Z]{3}$/.test(req.body.currency || '') ? req.body.currency : 'USD', housing: req.body.housing, scholarship: req.body.scholarship, years: req.body.years };
  const result = await calculator.calculate(input);
  if (!result.rows.length) { flash(req, 'error', req.t('calc.choose_destination')); return res.redirect(`/staff/students/${s.id}?tab=shortlist`); }
  const { id, token } = await calculator.saveEstimate(result, { studentId: s.id, userId: req.user.id, title: req.body.title || null, note: req.body.note || null });
  const link = `${res.locals.appUrl}/estimate/${token}`;
  let sent = false;
  if (req.body.send === '1' && s.email) {
    const t = translator(s.preferred_locale || 'en');
    const html = await email.layout({ locale: s.preferred_locale || 'en', title: t('calc.mail_subject'), body: t('calc.mail_body', { name: s.first_name, counsellor: req.user.name }), cta: t('calc.mail_cta'), href: link });
    const r = await email.send({ to: s.email, subject: t('calc.mail_subject'), html });
    sent = r.sent;
    if (sent) await knex('cost_estimates').where({ id }).update({ sent_at: new Date() });
  }
  await activity.log({ studentId: s.id }, { type: 'system', title: 'estimate_created', meta: { token, sent }, actorId: req.user.id, shareable: true });
  await audit.record(req.ctx, 'estimate.created', { entityType: 'student', entityId: s.id, newValues: { estimate: id, sent } });
  flash(req, sent || req.body.send !== '1' ? 'ok' : 'error', sent ? req.t('calc.sent') : req.body.send === '1' ? req.t('calc.not_sent') : req.t('calc.saved'));
  return res.redirect(`/staff/students/${s.id}?tab=shortlist`);
}));

module.exports = router;
