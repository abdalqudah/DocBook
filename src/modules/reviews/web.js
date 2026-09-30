// /app/website/reviews (Website → Reviews; old address /app/reviews): the clinic's verified reviews — filters (doctor, rating, status), average and distribution,
// one public reply per review and "report to the platform". Reviews cannot be edited or deleted by the clinic.
// Members with reviews.view but without reviews.manage (doctors) see only the reviews of their own visits.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const reviews = require('./reviews.service');
const { errText } = require('../messaging/pages');

const tr = (req, extra) => ({ ...extra, formError: extra.formError && { ...extra.formError, message: errText(req, extra.formError) } });

const router = express.Router();
router.use(can('reviews.view'));

/** Managers see the whole clinic; everyone else only their own doctor profile (none when not linked). */
const scope = (req) => ({ ...req.ctx, ownDoctorId: req.ctx.permissions.has('reviews.manage') ? null : (req.ctx.doctorId || -1) });

async function page(req, res, extra = {}) {
  const ctx = scope(req);
  const f = {
    doctor: ctx.ownDoctorId ? 'all' : String(req.query.doctor || 'all'),
    rating: /^[1-5]$/.test(String(req.query.rating || '')) ? String(req.query.rating) : '',
    status: ['unanswered', 'reported', 'hidden'].includes(req.query.status) ? req.query.status : '',
  };
  const [data, stats, doctors] = await Promise.all([
    reviews.list(ctx, { ...f, page: req.query.page }),
    reviews.stats(ctx, { doctor: f.doctor }),
    ctx.ownDoctorId ? [] : knex('doctors').where({ business_id: req.ctx.businessId }).orderBy([{ column: 'is_active', order: 'desc' }, { column: 'full_name' }]).select('id', 'full_name', 'full_name_en', 'color'),
  ]);
  res.page('pages/engage/reviews', {
    title: req.t('reviews.title'), ...data, stats, doctors, f, focus: Number(req.query.focus) || null,
    publicUrl: req.business.slug ? `/${req.business.slug}#reviews` : null, canManage: req.ctx.permissions.has('reviews.manage'),
    pageStyles: ['/css/engage.css'], ...extra,
  });
}

router.get('/', wrap((req, res) => page(req, res)));

router.post('/:id(\\d+)/reply', can('reviews.manage'), form(async (req, res) => {
  await reviews.reply(scope(req), req.params.id, req.body);
  flash(req, 'success', req.t('reviews.replied'));
  res.redirect(`/app/website/reviews?focus=${Number(req.params.id)}#review-${Number(req.params.id)}`);
}, (req, res, extra) => page(req, res, { ...tr(req, extra), replyFor: Number(req.params.id) })));

router.post('/:id(\\d+)/report', can('reviews.manage'), form(async (req, res) => {
  await reviews.report(scope(req), req.params.id, req.body);
  flash(req, 'success', req.t('reviews.reported_ok'));
  res.redirect(`/app/website/reviews?focus=${Number(req.params.id)}#review-${Number(req.params.id)}`);
}, (req, res, extra) => page(req, res, { ...tr(req, extra), reportFor: Number(req.params.id) })));

module.exports = router;
