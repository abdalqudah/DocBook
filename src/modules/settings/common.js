// Settings area: navigation model and the page renderer shared by every settings screen.
const config = require('../../config');

// One definition feeds the settings sidebar (tabs on mobile) and the overview cards.
// `perms`: any of them grants the section; an empty list means every member.
const SECTIONS = [
  { group: 'clinic', items: [
    { key: 'clinic', href: '/app/settings/clinic', icon: 'building-2', perms: ['settings.manage'] },
    { key: 'portal', href: '/app/settings/portal', icon: 'globe', perms: ['settings.manage'] },
    { key: 'booking_links', href: '/app/settings/booking-links', icon: 'link', perms: ['settings.manage'] },
    { key: 'messaging', href: '/app/settings/messaging', icon: 'message-circle', perms: ['settings.manage'] },
  ] },
  { group: 'team', items: [
    { key: 'team', href: '/app/settings/team', icon: 'user-cog', perms: ['users.manage'] },
    { key: 'roles', href: '/app/settings/roles', icon: 'shield-check', perms: ['roles.manage'] },
  ] },
  { group: 'clinical', items: [
    { key: 'insurance', href: '/app/settings/insurance', icon: 'shield-plus', perms: ['settings.manage'] },
    { key: 'medications', href: '/app/settings/medications', icon: 'pill', perms: ['settings.manage', 'prescriptions.create'] },
  ] },
  { group: 'personal', items: [
    { key: 'account', href: '/app/settings/account', icon: 'user', perms: [] },
    { key: 'security', href: '/app/settings/security', icon: 'key-round', perms: [] },
    { key: 'appearance', href: '/app/settings/appearance', icon: 'palette', perms: [] },
  ] },
  { group: 'data', items: [
    { key: 'data', href: '/app/settings/data', icon: 'database', perms: ['audit.view', 'data.export', 'data.manage'] },
    { key: 'database', href: '/app/settings/database', icon: 'plug', perms: ['data.manage'] },
  ] },
];

function sectionsFor(permissions) {
  const ok = (item) => !item.perms.length || item.perms.some((p) => permissions.has(p));
  return SECTIONS.map((g) => ({ group: g.group, items: g.items.filter(ok) })).filter((g) => g.items.length);
}

/** Renders a settings screen inside the settings layout (sidebar + content). */
function render(req, res, view, section, data = {}) {
  return res.page(`pages/settings/${view}`, {
    title: data.title || req.t(`settings.nav_${section}`),
    section,
    settingsNav: sectionsFor(req.ctx.permissions),
    pageStyles: ['/css/admin.css'],
    pageScripts: ['/js/admin.js'],
    ...data,
  });
}

/** Absolute base URL for links shown to staff (APP_URL when configured, else the current host). */
const baseUrl = (req) => (process.env.APP_URL ? config.appUrl.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`);

/** Shown-once secrets (temporary passwords, invitation and reset links) survive one redirect in the session. */
function stash(req, key, value) { req.session[key] = value; }
function takeStash(req, key) { const v = req.session[key]; delete req.session[key]; return v || null; }

/** Rewrites links built from APP_URL so the admin sees an address that works from this host. */
const localise = (req, link) => (link ? String(link).replace(/^https?:\/\/[^/]+/, baseUrl(req)) : link);

module.exports = { SECTIONS, sectionsFor, render, baseUrl, stash, takeStash, localise };
