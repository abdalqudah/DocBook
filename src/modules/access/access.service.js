// Per-member page access (worker: access) — "the clinic owner or admin gives any employee access to pages, or removes it".
//
// A PAGE is a menu item of src/routes/nav.js (key/href/perms) or a Settings section of src/modules/settings/common.js
// (key `settings_<key>`; a section whose href is already a menu page — Team — is that page). On top of the member's
// role, member_page_access rows say:
//   allow → the page's permissions are ADDED:
//             • view level: the page's viewing permission — the first of its `perms` ending in .view / .view_all / .use,
//               else its first permission (appointments → appointments.view, doctors → appointments.view_all,
//               expenses → expenses.view, cashier → billing.manage, front desk → frontdesk.use …);
//             • manage level (pages with a clear pair only, see MANAGE): the page's editing permissions as well
//               (expenses → expenses.manage, patients → patients.create + patients.edit, appointments → appointments.manage …).
//           Pages that only open through a clinic-administration permission (users/roles/settings/data management,
//           audit) and every Settings section can't be allowed one by one — they follow the role (they can be denied).
//   deny  → the page is hidden from the menu and its addresses are blocked (gate.js). Its permissions (and the ones
//           that imply them) are removed, EXCEPT those another page the member can still open lists — so shared
//           permissions (expenses.view for Expenses + Budgets) keep the other page working — and scope permissions
//           (appointments.view_all decides "all doctors' schedules" vs "own schedule", so it's never removed).
//   Pages the added permissions would open as a side effect (allow Expenses → Budgets also needs expenses.view)
//   stay hidden and blocked: an allow opens that page only.
// The owner is never restricted. Core pages (settings overview, account, security, appearance, personal
// notifications, help) can't be denied. The result is computed inside rbac.service loadPermissions (cached per
// clinic + user and invalidated on every change) and carried on the permission Set as `pagesOff`.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { ALL, IMPLIES, normalise } = require('../rbac/permissions');

const CORE = new Set(['settings', 'support', 'settings_account', 'settings_security', 'settings_appearance', 'settings_notifications']);
const ADMIN_PERMS = new Set(['users.manage', 'roles.manage', 'settings.manage', 'data.manage', 'audit.view']);
const PROTECTED = new Set(['appointments.view_all']);
// Features with their own address inside another page's address (they keep their own permission checks).
const INDEPENDENT = ['/app/finance/assistant'];
// Explicit "manage" level for pages whose editing permissions aren't simply <x>.manage.
const MANAGE = {
  appointments: ['appointments.manage'],
  patients: ['patients.create', 'patients.edit'],
  certificates: ['certificates.issue'],
  billing: ['billing.manage'],
  doctors: ['doctors.manage'],
};

const accessError = (code, message) => new AppError(code, message, 403);

let cached = null;
/** Every page, in menu order: { key, href, perms, exact, needsDoctor, group, groupLabel, label, icon, settings }. */
function pages() {
  if (cached) return cached;
  const { NAV } = require('../../routes/nav'); // eslint-disable-line global-require
  const { SECTIONS } = require('../settings/common'); // eslint-disable-line global-require
  const list = [];
  const byHref = new Map();
  for (const g of NAV) {
    for (const i of g.items) {
      const p = { key: i.key, href: i.href, perms: i.perms || [], exact: Boolean(i.exact || i.exactSettings), needsDoctor: Boolean(i.needsDoctor), needsCenter: Boolean(i.needsCenter), group: g.group, groupLabel: g.label || `nav.group_${g.group}`, groupFallback: `nav.group_${g.group}`, label: `nav.${i.key}`, icon: i.icon, settings: false, aliases: [], also: i.also || [] };
      list.push(p);
      byHref.set(i.href, p);
    }
  }
  for (const g of SECTIONS) {
    for (const i of g.items) {
      const key = `settings_${i.key}`;
      if (byHref.has(i.href)) { byHref.get(i.href).aliases.push(key); continue; }
      list.push({ key, href: i.href, perms: i.perms || [], exact: false, needsDoctor: false, group: `settings_${g.group}`, groupLabel: `settings.group_${g.group}`, label: `settings.nav_${i.key}`, icon: i.icon, settings: true, aliases: [], also: [] });
    }
  }
  for (const p of list) {
    p.core = CORE.has(p.key);
    p.viewPerm = p.perms.find((x) => /\.(view|view_all|use)$/.test(x)) || p.perms[0] || null;
    const auto = p.viewPerm && /\.view$/.test(p.viewPerm) ? p.viewPerm.replace(/\.view$/, '.manage') : null;
    p.managePerms = MANAGE[p.key] || (auto && ALL.includes(auto) && auto !== p.viewPerm ? [auto] : []);
    p.allowable = !p.settings && Boolean(p.viewPerm) && !ADMIN_PERMS.has(p.viewPerm);
    p.hasLevels = p.allowable && p.managePerms.length > 0;
  }
  cached = list;
  return list;
}
const pageByKey = (key) => pages().find((p) => p.key === key || p.aliases.includes(key)) || null;

const opens = (perms, p) => !p.perms.length || p.perms.some((x) => perms.has(x));
/** Permissions an 'allow' row adds. */
const grantOf = (p, level) => (p.allowable ? [p.viewPerm, ...(level === 'manage' ? p.managePerms : [])] : []);
/** Permissions a page relies on (its own list, its editing permissions and whatever implies them). */
function familyOf(p) {
  const base = new Set([...p.perms, ...p.managePerms]);
  for (const [from, to] of Object.entries(IMPLIES)) if (base.has(to)) base.add(from);
  return base;
}

/**
 * Applies the member's rows to the role's permissions.
 * @returns {Set} effective permissions, with `pagesOff` (Set of page keys incl. aliases) attached.
 */
function compute(rolePerms, rows, { doctorId = null } = {}) {
  const role = new Set(normalise([...rolePerms]));
  const list = pages();
  const allowed = new Map();
  const denied = new Set();
  for (const r of rows) {
    const p = pageByKey(r.page_key);
    if (!p) continue;
    if (r.mode === 'allow' && p.allowable) allowed.set(p.key, r.level === 'manage' && p.hasLevels ? 'manage' : 'view');
    if (r.mode === 'deny' && !p.core) denied.add(p.key);
  }
  const eff = new Set(normalise([...role, ...[...allowed].flatMap(([k, level]) => grantOf(pageByKey(k), level))]));
  const usable = (p) => opens(eff, p) && (!p.needsDoctor || doctorId);
  const off = new Set(denied);
  // An allow opens that page only: pages opened as a side effect of the added permissions stay closed.
  for (const p of list) if (!off.has(p.key) && usable(p) && !(opens(role, p) && (!p.needsDoctor || doctorId)) && !allowed.has(p.key)) off.add(p.key);
  if (denied.size) {
    const needed = new Set();
    // A centre-only page (a practice's centre costs) is a side view: it never keeps a denied page's permission alive.
    for (const p of list) if (!off.has(p.key) && usable(p) && !p.needsCenter) for (const x of familyOf(p)) needed.add(x);
    for (const k of denied) for (const x of familyOf(pageByKey(k))) if (!needed.has(x) && !PROTECTED.has(x)) eff.delete(x);
  }
  const out = new Set(normalise([...eff]));
  const pagesOff = new Set();
  for (const k of off) { pagesOff.add(k); for (const a of pageByKey(k).aliases) pagesOff.add(a); }
  Object.defineProperty(out, 'pagesOff', { value: pagesOff, enumerable: false });
  return out;
}

// Rows are read defensively: before the migration has run, everybody simply follows their role.
async function rowsFor(businessId, where) {
  try { return await knex('member_page_access').where({ business_id: businessId, ...where }).select('page_key', 'mode', 'level', 'membership_id', 'updated_at', 'granted_by'); } catch (e) {
    if (e && (e.code === 'ER_NO_SUCH_TABLE' || /no such table|doesn't exist/i.test(e.message || ''))) return [];
    throw e;
  }
}

/** Called by rbac.service loadPermissions for every non-owner member. */
async function effective(businessId, userId, rolePerms, membership) {
  const rows = await rowsFor(businessId, { membership_id: membership.id });
  if (!rows.length) return new Set(rolePerms);
  return compute(rolePerms, rows, { doctorId: membership.doctor_id });
}

/** The page an /app address belongs to: the longest matching href (exact pages match only themselves). */
function pageForPath(fullPath) {
  const path = String(fullPath || '').split('?')[0].replace(/(.)\/+$/, '$1');
  if (INDEPENDENT.some((x) => path === x || path.startsWith(`${x}/`))) return null;
  let best = null;
  for (const p of pages()) {
    const within = (h) => path === h || path.startsWith(`${h}/`);
    const hrefs = p.exact ? [] : [p.href, ...(p.also || [])];
    const len = p.exact ? (path === p.href ? p.href.length : 0) : Math.max(0, ...hrefs.filter(within).map((h) => h.length));
    if (len && (!best || len > best.len)) best = { page: p, len };
  }
  return best ? best.page : null;
}

const parse = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })());

async function memberRow(businessId, membershipId) {
  const m = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').join('users as u', 'u.id', 'm.user_id')
    .where({ 'm.id': membershipId, 'm.business_id': businessId })
    .first('m.id', 'm.user_id', 'm.doctor_id', 'm.status', 'r.key as role_key', 'r.name as role_name', 'r.is_system', 'r.permissions', 'u.name', 'u.email');
  if (!m) throw E.notFound('Staff member');
  return { ...m, rolePerms: m.role_key === 'owner' ? ALL : normalise(parse(m.permissions)) };
}

/** State of one member's pages for the access screen. */
async function memberAccess(businessId, membershipId) {
  const m = await memberRow(businessId, membershipId);
  const rows = await rowsFor(businessId, { membership_id: m.id });
  const byKey = new Map(rows.map((r) => [pageByKey(r.page_key) ? pageByKey(r.page_key).key : r.page_key, r]));
  const role = new Set(m.rolePerms);
  const eff = m.role_key === 'owner' ? new Set(ALL) : compute(m.rolePerms, rows, { doctorId: m.doctor_id });
  const offSet = eff.pagesOff || new Set();
  const list = pages().filter((p) => !p.needsDoctor || m.doctor_id).map((p) => {
    const r = byKey.get(p.key);
    const mode = r ? r.mode : 'default';
    return { ...p, byRole: opens(role, p), mode, level: r && r.mode === 'allow' ? (r.level || 'view') : null, open: opens(eff, p) && !offSet.has(p.key) };
  });
  return { member: m, pages: list, summary: summarise(list) };
}

function summarise(list) {
  return {
    added: list.filter((p) => p.mode === 'allow' && !p.byRole).length,
    removed: list.filter((p) => p.mode === 'deny' && p.byRole).length,
    custom: list.filter((p) => p.mode !== 'default').length,
  };
}

/** { membershipId: { added, removed } } for the team list. */
async function summaries(businessId) {
  const rows = await rowsFor(businessId, {});
  if (!rows.length) return {};
  const ms = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where('m.business_id', businessId).whereIn('m.id', [...new Set(rows.map((r) => r.membership_id))])
    .select('m.id', 'm.doctor_id', 'r.key', 'r.permissions');
  const out = {};
  for (const m of ms) {
    if (m.key === 'owner') continue;
    const role = new Set(normalise(parse(m.permissions)));
    let added = 0; let removed = 0;
    for (const r of rows.filter((x) => x.membership_id === m.id)) {
      const p = pageByKey(r.page_key);
      if (!p || (p.needsDoctor && !m.doctor_id)) continue;
      if (r.mode === 'allow' && p.allowable && !opens(role, p)) added += 1;
      if (r.mode === 'deny' && !p.core && opens(role, p)) removed += 1;
    }
    if (added || removed) out[m.id] = { added, removed };
  }
  return out;
}

/** Can the actor open page `p` themselves (and use its editing permissions for level 'manage')? */
function actorCan(ctx, p, level) {
  const perms = ctx.permissions;
  if (!opens(perms, p) || (perms.pagesOff && perms.pagesOff.has(p.key))) return false;
  return level !== 'manage' || p.managePerms.every((x) => perms.has(x));
}

async function actorIsOwner(ctx) {
  if (ctx.roleKey) return ctx.roleKey === 'owner';
  const r = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.business_id': ctx.businessId, 'm.user_id': ctx.userId }).first('r.key');
  return Boolean(r && r.key === 'owner');
}

const describe = (mode, level) => (mode === 'allow' ? `allow${level === 'manage' ? ':manage' : ''}` : mode);

/**
 * Saves a member's page access.
 * @param {object} changes { pageKey: { mode: 'default'|'allow'|'deny', level?: 'view'|'manage' } } — pages left out keep their state.
 * @returns {number} how many pages changed
 */
async function save(ctx, membershipId, changes) {
  if (!ctx.permissions || !ctx.permissions.has('users.manage')) throw E.forbidden('users.manage');
  const m = await memberRow(ctx.businessId, membershipId);
  if (m.role_key === 'owner') throw accessError('ACCESS_OWNER', 'The owner always has access to every page.');
  if (m.user_id === ctx.userId) throw accessError('ACCESS_SELF', 'You can\'t change your own page access.');
  const owner = await actorIsOwner(ctx);
  const rows = await rowsFor(ctx.businessId, { membership_id: m.id });
  const current = new Map(rows.map((r) => [r.page_key, r]));
  const done = [];
  for (const [key, want] of Object.entries(changes || {})) {
    const p = pageByKey(key);
    if (!p) continue;
    const mode = ['allow', 'deny'].includes(want && want.mode) ? want.mode : 'default';
    const level = mode === 'allow' && p.hasLevels && want.level === 'manage' ? 'manage' : (mode === 'allow' && p.hasLevels ? 'view' : null);
    const cur = current.get(p.key);
    const from = cur ? describe(cur.mode, cur.level) : 'default';
    const to = mode === 'default' ? 'default' : describe(mode, level);
    if (from === to) continue;
    if (mode === 'deny' && p.core) throw accessError('ACCESS_CORE', 'This page is needed to use DocBook and is always available.');
    if (mode === 'allow' && !p.allowable) throw accessError('ACCESS_ROLE_ONLY', 'This page is given through the role only.');
    // A manager can't hand out what they can't open themselves.
    if (mode === 'allow' && !owner && !actorCan(ctx, p, level)) throw accessError('ACCESS_BEYOND_OWN', 'You can only give access to pages you can open yourself.');
    done.push({ p, cur, mode, level, from, to });
  }
  if (!done.length) return 0;
  await knex.transaction(async (trx) => {
    for (const d of done) {
      if (d.mode === 'default') await trx('member_page_access').where({ membership_id: m.id, page_key: d.p.key }).del(); // eslint-disable-line no-await-in-loop
      else if (d.cur) await trx('member_page_access').where({ membership_id: m.id, page_key: d.p.key }).update({ mode: d.mode, level: d.level, granted_by: ctx.userId, updated_at: new Date() }); // eslint-disable-line no-await-in-loop
      else await trx('member_page_access').insert({ business_id: ctx.businessId, membership_id: m.id, user_id: m.user_id, page_key: d.p.key, mode: d.mode, level: d.level, granted_by: ctx.userId }); // eslint-disable-line no-await-in-loop
      await audit.record(ctx, 'staff.page_access', { entityType: 'staff', entityId: m.user_id, oldValues: { member: m.name, page: d.p.key, access: d.from }, newValues: { member: m.name, page: d.p.key, access: d.to } }, trx); // eslint-disable-line no-await-in-loop
    }
  });
  require('../rbac/rbac.service').invalidate(ctx.businessId); // eslint-disable-line global-require
  return done.length;
}

/** Back to the role: removes every row of the member. */
async function reset(ctx, membershipId) {
  const rows = await rowsFor(ctx.businessId, { membership_id: membershipId });
  return save(ctx, membershipId, Object.fromEntries(rows.map((r) => [r.page_key, { mode: 'default' }])));
}

module.exports = { CORE, INDEPENDENT, pages, pageByKey, pageForPath, compute, effective, memberAccess, summaries, save, reset, opens };
