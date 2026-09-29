// Platform admin → reps & warehouses (vendors): review sign-ups, approve / suspend / reactivate, and hide a
// product or offer that is not appropriate. Mounted inside admin/web.js after its platform-admin guard
// (req.ctx is the platform scope, so every audit row has business_id NULL).
const express = require('express');
const config = require('../../config');
const mailer = require('../../core/mailer');
const brand = require('../../config/brand');
const { translator } = require('../../core/i18n');
const { wrap, flash } = require('../../routes/helpers');
const knex = require('../../db/knex');
const vendors = require('../vendors/vendor.service');

const router = express.Router();
const page = (res, view, data) => res.page(`pages/admin/vendors/${view}`, { layout: 'admin', pageStyles: ['/css/site.css', '/css/vendors.css'], ...data });

router.get('/vendors', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const status = vendors.STATUSES.includes(req.query.status) ? req.query.status : '';
  const data = await vendors.adminList({ q, status, page: req.query.page });
  page(res, 'index', { title: req.t('vendors.admin.title'), ...data, q, status });
}));

router.get('/vendors/:id(\\d+)', wrap(async (req, res) => {
  const data = await vendors.adminDetail(Number(req.params.id));
  page(res, 'detail', { title: data.v.name, ...data });
}));

/** E-mails the vendor's owners that their account was approved (only when e-mail is set up). */
async function mailApproved(res, vendor) {
  if (!mailer.configured()) return;
  const owners = await knex('vendor_users as vu').join('users as u', 'u.id', 'vu.user_id').where('vu.vendor_id', vendor.id).select('u.email', 'u.name', 'u.locale');
  const to = new Set([vendor.email, ...owners.map((o) => o.email)].filter(Boolean).map((e) => e.toLowerCase()));
  const locale = (owners[0] && owners[0].locale) || 'ar';
  const t = translator(locale);
  const base = String(res.locals.baseUrl || config.appUrl).replace(/\/+$/, '');
  await Promise.all([...to].map((email) => mailer.send({
    to: email, subject: `${brand.name} — ${t('vendors.mail_approved_subject')}`,
    html: mailer.layout({ locale, title: t('vendors.mail_approved_subject'), body: t('vendors.mail_approved_body', { name: vendor.name }), cta: t('vendors.mail_approved_cta'), href: `${base}/vendor` }),
  }).catch((e) => console.error('[mail] vendor approval failed:', e.message)))); // eslint-disable-line no-console
}

router.post('/vendors/:id(\\d+)/status', wrap(async (req, res) => {
  const next = ['active', 'suspended'].includes(req.body.status) ? req.body.status : null;
  if (!next) { flash(req, 'error', req.t('errors.VALIDATION_FAILED')); return res.redirect('/admin/vendors'); }
  const out = await vendors.setStatus(req.ctx, Number(req.params.id), next);
  if (out.changed && out.firstApproval) await mailApproved(res, out.vendor);
  const key = !out.changed ? 'vendors.admin.no_change' : out.action === 'platform.vendor_suspended' ? 'vendors.admin.suspended_done'
    : out.action === 'platform.vendor_approved' ? 'vendors.admin.approved_done' : 'vendors.admin.reactivated_done';
  flash(req, 'success', req.t(key, { name: out.vendor.name }));
  return res.redirect(req.body.back === 'list' ? '/admin/vendors' : `/admin/vendors/${out.vendor.id}`);
}));

router.post('/vendors/products/:id(\\d+)/hide', wrap(async (req, res) => {
  const p = await vendors.hideProduct(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('vendors.admin.product_hidden'));
  res.redirect(`/admin/vendors/${p.vendor_id}#products`);
}));

router.post('/vendors/offers/:id(\\d+)/hide', wrap(async (req, res) => {
  const o = await vendors.hideOffer(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('vendors.admin.offer_hidden'));
  res.redirect(`/admin/vendors/${o.vendor_id}#offers`);
}));

module.exports = router;
