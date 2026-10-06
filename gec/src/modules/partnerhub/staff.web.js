// Staff side of the partner portal: partnership requests from the website (partners.manage), the review queue for
// what universities submit (catalog.manage), and university staff accounts (partners.manage).
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah, idParam } = require('../../core/http');
const { E } = require('../../core/errors');
const { z, validate } = require('../../core/validate');
const nav = require('../staff/nav');
const svc = require('./service');
const mail = require('./mail');

const countOf = async (q) => Number((await q.count({ n: '*' }))[0].n);
nav.add('admissions', { key: 'partner_submissions', href: '/staff/partner-submissions', icon: 'inbox', perms: ['catalog.manage'], badge: () => countOf(knex('partner_submissions').where({ status: 'pending' })) });
nav.add('finance', { key: 'partner_requests', href: '/staff/partner-requests', icon: 'handshake', perms: ['partners.manage'], badge: () => countOf(knex('partner_applications').where({ status: 'new' })) });
nav.add('finance', { key: 'partner_accounts', href: '/staff/partner-accounts', icon: 'user-cog', perms: ['partners.manage'] });

const router = express.Router();
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const STATUSES = ['new', 'approved', 'rejected'];
const SUB_STATUSES = ['pending', 'changes_requested', 'approved', 'rejected'];

// ------------------------------------------------------------------ partnership requests
router.get('/partner-requests', can('partners.manage'), ah(async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : 'new';
  const rows = await knex('partner_applications').where({ status }).orderBy('id', 'desc').limit(200);
  res.page('pages/staff/partners/requests', { layout: 'staff', title: req.t('nav.partner_requests'), rows, status });
}));
router.get('/partner-requests/:id', can('partners.manage'), ah(async (req, res) => {
  const a = await knex('partner_applications').where({ id: idParam(req.params.id) }).first();
  if (!a) throw E.notFound();
  const universities = await knex('universities').orderBy('name_en').select('id', 'name_en', 'country_code');
  const guess = universities.find((u) => u.name_en.toLowerCase() === a.university_name.toLowerCase());
  res.page('pages/staff/partners/request', { layout: 'staff', narrow: true, title: a.ref, a, universities, guess, errors: {}, old: {} });
}));
router.post('/partner-requests/:id/approve', can('partners.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  const d = validate(z.object({
    university_id: z.preprocess((v) => (v === '' || v === 'new' ? undefined : v), z.coerce.number().int().positive().optional()),
    commission_type: z.enum(['percent', 'fixed']).default('percent'),
    commission_rate: z.coerce.number().min(0).max(1000000),
    currency: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^[A-Z]{3}$/).optional()),
  }), req.body);
  const r = await svc.approve(req.ctx, id, { universityId: d.university_id, createUniversity: req.body.university_id === 'new', commissionType: d.commission_type, commissionRate: d.commission_rate, currency: d.currency });
  const uni = await knex('universities').where({ id: r.universityId }).first('name_en');
  if (r.link) await mail.sendInvite(r.user.email, r.user.name, r.link, uni.name_en, r.user.locale || 'en');
  flash(req, 'ok', req.t('partnerp.request_approved'));
  res.redirect(`/staff/partner-requests/${id}`);
}));
router.post('/partner-requests/:id/reject', can('partners.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  await svc.reject(req.ctx, id, req.body.review_note);
  flash(req, 'ok', req.t('partnerp.request_rejected'));
  res.redirect('/staff/partner-requests');
}));

// ------------------------------------------------------------------ submissions review
router.get('/partner-submissions', can('catalog.manage'), ah(async (req, res) => {
  const status = SUB_STATUSES.includes(req.query.status) ? req.query.status : 'pending';
  const rows = (await knex('partner_submissions as s').join('universities as u', 'u.id', 's.university_id').leftJoin('users as us', 'us.id', 's.submitted_by')
    .where('s.status', status).orderBy('s.updated_at', status === 'pending' ? 'asc' : 'desc').limit(200)
    .select('s.*', 'u.name_en as uni_en', 'u.name_ar as uni_ar', 'u.slug as uni_slug', 'us.name as by_name')).map((s) => ({ ...s, data: parseJson(s.data) }));
  res.page('pages/staff/partners/submissions', { layout: 'staff', title: req.t('nav.partner_submissions'), rows, status });
}));
router.get('/partner-submissions/:id', can('catalog.manage'), ah(async (req, res) => {
  const sub = await knex('partner_submissions as s').join('universities as u', 'u.id', 's.university_id').leftJoin('users as us', 'us.id', 's.submitted_by')
    .where('s.id', idParam(req.params.id)).first('s.*', 'u.name_en as uni_en', 'u.name_ar as uni_ar', 'u.slug as uni_slug', 'us.name as by_name', 'us.email as by_email');
  if (!sub) throw E.notFound();
  const rows = await svc.diff(sub);
  const commission = sub.entity === 'program' && sub.entity_id ? await knex('programs').where({ id: sub.entity_id }).first('commission_type', 'commission_rate') : null;
  res.page('pages/staff/partners/submission', { layout: 'staff', title: req.t(`partnerp.entity.${sub.entity}`), sub: { ...sub, data: parseJson(sub.data) }, rows, commission, errors: {}, old: {} });
}));
router.post('/partner-submissions/:id', can('catalog.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  const action = req.body.action;
  if (action === 'approve') {
    const publishedId = await svc.approveSubmission(req.ctx, id, { note: req.body.review_note });
    const sub = await knex('partner_submissions').where({ id }).first('entity');
    if (sub.entity === 'program' && ['inherit', 'percent', 'fixed'].includes(req.body.commission_type)) {
      const rate = req.body.commission_type === 'inherit' ? null : Math.max(0, Number(req.body.commission_rate) || 0);
      await knex('programs').where({ id: publishedId }).update({ commission_type: req.body.commission_type, commission_rate: rate });
      await audit.record(req.ctx, 'program.commission_set', { entityType: 'program', entityId: publishedId, newValues: { commission_type: req.body.commission_type, commission_rate: rate } });
    }
    flash(req, 'ok', req.t('partnerp.sub_approved'));
  } else if (['changes_requested', 'rejected'].includes(action)) {
    try { await svc.decline(req.ctx, id, action, req.body.review_note); } catch (e) {
      if (e.code !== 'VALIDATION_FAILED') throw e;
      flash(req, 'error', e.details.review_note);
      return res.redirect(`/staff/partner-submissions/${id}`);
    }
    flash(req, 'ok', req.t(`partnerp.sub_${action}`));
  } else throw E.validation({ action: 'Unknown action.' });
  return res.redirect('/staff/partner-submissions');
}));

// ------------------------------------------------------------------ university staff accounts
router.get('/partner-accounts', can('partners.manage'), ah(async (req, res) => {
  const rows = await knex('partner_members as m').join('users as u', 'u.id', 'm.user_id').join('universities as un', 'un.id', 'm.university_id')
    .orderBy('un.name_en').orderBy('u.name').select('u.id as user_id', 'u.name', 'u.email', 'u.status', 'u.last_login_at', 'm.role', 'm.job_title', 'un.id as university_id', 'un.name_en as uni_en', 'un.name_ar as uni_ar');
  const universities = await knex('universities').orderBy('name_en').select('id', 'name_en');
  res.page('pages/staff/partners/accounts', { layout: 'staff', title: req.t('nav.partner_accounts'), rows, universities, errors: {}, old: {} });
}));
router.post('/partner-accounts', can('partners.manage'), ah(async (req, res) => {
  const d = validate(z.object({ university_id: z.coerce.number().int().positive(), name: z.string().trim().min(2).max(160), email: z.string().trim().email().max(190), role: z.enum(['owner', 'editor']).default('editor'), job_title: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(120).optional()) }), req.body);
  const uni = await knex('universities').where({ id: d.university_id }).first('name_en');
  if (!uni) throw E.notFound();
  const r = await svc.invite(req.ctx, { universityId: d.university_id, name: d.name, email: d.email, role: d.role, jobTitle: d.job_title || null });
  if (r.link) await mail.sendInvite(d.email, d.name, r.link, uni.name_en);
  flash(req, 'ok', req.t('partnerp.invited'));
  res.redirect('/staff/partner-accounts');
}));
router.post('/partner-accounts/:userId/status', can('partners.manage'), ah(async (req, res) => {
  const userId = idParam(req.params.userId);
  const user = await knex('users').where({ id: userId, kind: 'partner' }).first('id', 'status');
  if (!user) throw E.notFound();
  const status = user.status === 'disabled' ? 'active' : 'disabled';
  await knex('users').where({ id: userId }).update({ status, updated_at: new Date() });
  if (status === 'disabled') await require('../auth/auth.service').endSessionsOf(userId); // eslint-disable-line global-require
  await audit.record(req.ctx, `partner.account_${status}`, { entityType: 'user', entityId: userId });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/partner-accounts');
}));

module.exports = router;
