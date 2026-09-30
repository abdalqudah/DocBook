// Settings → Team → Page access (worker: access). Mounted inside settings/team.web.js (behind users.manage).
//   GET  /app/settings/team/:id/access          the member's pages, grouped like the menu: role default / allow / deny
//   POST /app/settings/team/:id/access          save (fields p__<pageKey> = default|allow|deny, l__<pageKey> = manage)
//   POST /app/settings/team/:id/access/reset    back to the role (removes every per-page setting)
// Rules (enforced in access.service.save): the owner can't be restricted, nobody changes their own access, a manager
// who isn't the owner can only give pages they can open themselves, core pages can't be denied. Every change is audited.
const express = require('express');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { render } = require('../settings/common');
const access = require('./access.service');

const router = express.Router();
router.use(can('users.manage'));

const tr = (req, key, fallback) => { const s = req.t(key); return s === key ? (fallback ? req.t(fallback) : key) : s; };

async function renderAccess(req, res, extra = {}) {
  const id = Number(req.params.id);
  const data = await access.memberAccess(req.ctx.businessId, id);
  const m = data.member;
  const locked = m.role_key === 'owner' ? 'owner' : (m.user_id === req.ctx.userId ? 'self' : null);
  const isOwner = req.ctx.roleKey === 'owner';
  const mine = req.ctx.permissions;
  const clinicOff = req.ctx.clinicModulesOff || req.ctx.modulesOff || new Set();
  // Groups in menu order; Settings sections are grouped under their settings group.
  const groups = [];
  for (const p of data.pages) {
    let g = groups.find((x) => x.key === p.group);
    if (!g) {
      const title = p.settings ? `${req.t('nav.settings')} · ${tr(req, p.groupLabel)}` : tr(req, p.groupLabel, p.groupFallback);
      g = { key: p.group, title, pages: [] };
      groups.push(g);
    }
    const canGive = isOwner || ((!p.perms.length || p.perms.some((x) => mine.has(x))) && !(mine.pagesOff && mine.pagesOff.has(p.key)));
    const canGiveManage = isOwner || (canGive && p.managePerms.every((x) => mine.has(x)));
    g.pages.push({ ...p, title: tr(req, p.label), canGive, canGiveManage, moduleOff: clinicOff.has(p.key) });
  }
  const memberRole = m.is_system ? req.t(`roles.${m.role_key}`) : m.role_name;
  render(req, res, 'access', 'team', {
    title: req.t('access.title_named', { name: m.name }), member: m, memberRole, groups, summary: data.summary, locked,
    pageStyles: ['/css/admin.css', '/css/access.css'], pageScripts: ['/js/admin.js', '/js/access.js'], ...extra,
  });
}

router.get('/:id(\\d+)/access', wrap((req, res) => renderAccess(req, res)));

const errorText = (req, err) => { const k = `errors_access.${err.code}`; const s = req.t(k); return s === k ? (req.t(`errors.${err.code}`) !== `errors.${err.code}` ? req.t(`errors.${err.code}`) : err.message) : s; };

const run = (action) => wrap(async (req, res) => {
  const back = `/app/settings/team/${Number(req.params.id)}/access`;
  try {
    const n = await action(req);
    flash(req, n ? 'success' : 'info', n ? req.t('access.saved', { n }) : req.t('access.nothing_changed'));
    return res.redirect(back);
  } catch (err) {
    if (err instanceof AppError && err.status !== 404 && err.code !== 'PERMISSION_DENIED') {
      res.status(err.status);
      return renderAccess(req, res, { formError: { code: err.code, message: errorText(req, err) } });
    }
    throw err;
  }
});

router.post('/:id(\\d+)/access', run((req) => {
  const changes = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!k.startsWith('p__')) continue;
    const key = k.slice(3);
    changes[key] = { mode: String(v), level: req.body[`l__${key}`] === 'manage' ? 'manage' : 'view' };
  }
  return access.save(req.ctx, Number(req.params.id), changes);
}));

router.post('/:id(\\d+)/access/reset', run((req) => access.reset(req.ctx, Number(req.params.id))));

module.exports = router;
