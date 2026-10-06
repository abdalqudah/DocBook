// Staff: privacy requests (export / delete / correct), the retention overview and anonymisation (privacy.manage).
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah, idParam } = require('../../core/http');
const { E } = require('../../core/errors');
const nav = require('../staff/nav');
const svc = require('./service');

nav.add('system', { key: 'privacy_requests', href: '/staff/privacy', icon: 'shield-check', perms: ['privacy.manage'], badge: async () => Number((await knex('privacy_requests').whereIn('status', ['open', 'verifying']).count({ n: '*' }))[0].n) }, { before: 'settings' });

const router = express.Router();

router.get('/privacy', can('privacy.manage'), ah(async (req, res) => {
  const status = ['open', 'verifying', 'done', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const q = knex('privacy_requests as r').leftJoin('students as s', 's.id', 'r.student_id').orderBy('r.id', 'desc').limit(200).select('r.*', 's.ref as student_ref');
  if (status) q.where('r.status', status); else q.whereIn('r.status', ['open', 'verifying']);
  res.page('pages/staff/privacy/index', { layout: 'staff', title: req.t('nav.privacy_requests'), rows: await q, status, stale: (await svc.staleLeads()).length });
}));

router.get('/privacy/stale', can('privacy.manage'), ah(async (req, res) => {
  res.page('pages/staff/privacy/stale', { layout: 'staff', title: req.t('privacy.stale_title'), rows: await svc.staleLeads(), months: (await require('../settings/settings.service').get('privacy')).retention_months }); // eslint-disable-line global-require
}));
router.post('/privacy/stale', can('privacy.manage'), ah(async (req, res) => {
  const ids = [].concat(req.body.lead_id || []).map(Number).filter(Boolean);
  const allowed = new Set((await svc.staleLeads()).map((l) => l.id));
  let n = 0;
  for (const id of ids.filter((x) => allowed.has(x))) if (await svc.anonymizeLeadOnly(req.ctx, id)) n += 1; // eslint-disable-line no-await-in-loop
  flash(req, 'ok', req.t('privacy.anonymized_n', { n }));
  res.redirect('/staff/privacy/stale');
}));

router.get('/privacy/:id', can('privacy.manage'), ah(async (req, res) => {
  const r = await knex('privacy_requests').where({ id: idParam(req.params.id) }).first();
  if (!r) throw E.notFound();
  const matches = r.student_id ? [] : (r.email ? await knex('students').where({ email: r.email }).whereNull('anonymized_at').select('id', 'ref', 'first_name', 'last_name', 'email') : []);
  const leadMatches = r.lead_id || r.student_id || !r.email ? [] : await knex('leads').where({ email: r.email }).whereNull('student_id').whereNull('anonymized_at').select('id', 'ref', 'first_name', 'last_name', 'email');
  const student = r.student_id ? await knex('students').where({ id: r.student_id }).first('id', 'ref', 'first_name', 'last_name', 'email', 'anonymized_at') : null;
  res.page('pages/staff/privacy/request', { layout: 'staff', narrow: true, title: r.ref, r, matches, leadMatches, student });
}));

router.post('/privacy/:id', can('privacy.manage'), ah(async (req, res) => {
  const r = await knex('privacy_requests').where({ id: idParam(req.params.id) }).first();
  if (!r) throw E.notFound();
  const upd = { updated_at: new Date() };
  if (/^\d+$/.test(req.body.student_id || '')) upd.student_id = Number(req.body.student_id);
  if (/^\d+$/.test(req.body.lead_id || '')) upd.lead_id = Number(req.body.lead_id);
  if (req.body.identity_verified === '1') upd.identity_verified = true;
  if (['open', 'verifying', 'done', 'rejected'].includes(req.body.status)) { upd.status = req.body.status; if (['done', 'rejected'].includes(req.body.status)) { upd.handled_by = req.user.id; upd.handled_at = new Date(); } }
  if (req.body.resolution !== undefined) upd.resolution = String(req.body.resolution).slice(0, 500) || null;
  await knex('privacy_requests').where({ id: r.id }).update(upd);
  await audit.record(req.ctx, 'privacy.request_updated', { entityType: 'privacy_request', entityId: r.id, oldValues: { status: r.status }, newValues: upd });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(`/staff/privacy/${r.id}`);
}));

router.get('/privacy/:id/export', can('privacy.manage'), ah(async (req, res) => {
  const r = await knex('privacy_requests').where({ id: idParam(req.params.id) }).first();
  if (!r || !r.student_id) throw E.validation({ student_id: 'Link the request to a student first.' });
  if (!r.identity_verified) throw E.validation({ identity_verified: 'Confirm the person’s identity first.' });
  const data = await svc.exportStudent(r.student_id);
  await audit.record(req.ctx, 'privacy.exported', { entityType: 'student', entityId: r.student_id, newValues: { request: r.ref } });
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="gec-data-${r.ref}.json"` }).send(JSON.stringify(data, null, 2));
}));

router.post('/privacy/:id/anonymize', can('privacy.manage'), ah(async (req, res) => {
  const r = await knex('privacy_requests').where({ id: idParam(req.params.id) }).first();
  if (!r) throw E.notFound();
  if (!r.identity_verified) throw E.validation({ identity_verified: 'Confirm the person’s identity first.' });
  if (req.body.confirm !== 'DELETE') throw E.validation({ confirm: 'Type DELETE to confirm.' });
  const done = r.student_id ? await svc.anonymizeStudent(req.ctx, r.student_id) : (r.lead_id ? await svc.anonymizeLeadOnly(req.ctx, r.lead_id) : false);
  if (!done) throw E.validation({ student_id: 'Link the request to a student or lead first (or it was already anonymised).' });
  await knex('privacy_requests').where({ id: r.id }).update({ status: 'done', handled_by: req.user.id, handled_at: new Date(), resolution: 'Personal data anonymised.' });
  flash(req, 'ok', req.t('privacy.anonymized'));
  res.redirect(`/staff/privacy/${r.id}`);
}));

module.exports = router;
