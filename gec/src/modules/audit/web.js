// Audit log viewer (who changed what, when, from where).
const express = require('express');
const knex = require('../../db/knex');
const { can } = require('../../middleware/auth');
const { ah, page } = require('../../core/http');
const nav = require('../staff/nav');

nav.add('system', { key: 'audit', href: '/staff/audit', icon: 'history', perms: ['audit.view'] });

const router = express.Router();
const PER = 50;

router.get('/', can('audit.view'), ah(async (req, res) => {
  const q = knex('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id');
  if (req.query.action) q.where('a.action', 'like', `${String(req.query.action).replace(/[%_]/g, '')}%`);
  if (req.query.entity) q.where('a.entity_type', String(req.query.entity));
  if (req.query.entity_id) q.where('a.entity_id', String(req.query.entity_id));
  if (/^\d+$/.test(req.query.user || '')) q.where('a.user_id', Number(req.query.user));
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) q.where('a.created_at', '>=', `${req.query.from} 00:00:00`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) q.where('a.created_at', '<=', `${req.query.to} 23:59:59`);
  const [{ n }] = await q.clone().count({ n: '*' });
  const p = page(req);
  const rows = await q.select('a.*', 'u.name as user_name', 'u.kind as user_kind').orderBy('a.id', 'desc').limit(PER).offset((p - 1) * PER);
  const entities = (await knex('audit_logs').distinct('entity_type').whereNotNull('entity_type').orderBy('entity_type')).map((r) => r.entity_type);
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  res.page('pages/staff/audit', {
    layout: 'staff', title: req.t('nav.audit'), entities,
    rows: rows.map((r) => ({ ...r, old: parse(r.old_values), new: parse(r.new_values) })),
    meta: { total: Number(n), page: p, pages: Math.max(1, Math.ceil(Number(n) / PER)) },
  });
}));

module.exports = router;
