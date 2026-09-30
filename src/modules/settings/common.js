// Settings area: navigation model and the page renderer shared by every settings screen.
const config = require('../../config');

// One definition feeds the settings sidebar (tabs on mobile) and the overview cards.
// `perms`: any of them grants the section; an empty list means every member.
const SECTIONS = [
  { group: 'profile', items: [
    { key: 'clinic', href: '/app/settings/clinic', icon: 'building-2', perms: ['settings.manage'] },
  ] },
  // The clinic online (moves to the Website workspace, redesign phase 4).
  { group: 'online', items: [
    { key: 'portal', href: '/app/settings/portal', icon: 'globe', perms: ['settings.manage'] },
    { key: 'booking_links', href: '/app/settings/booking-links', icon: 'link', perms: ['settings.manage'] },
    { key: 'media', href: '/app/settings/media', icon: 'images', perms: ['settings.manage'] },
  ] },
  { group: 'documents', items: [
    { key: 'invoice_template', href: '/app/settings/invoice', icon: 'printer', perms: ['settings.manage'] },
  ] },
  { group: 'communication', items: [
    { key: 'messaging', href: '/app/settings/messaging', icon: 'message-circle', perms: ['settings.manage'] },
    { key: 'notifications', href: '/app/settings/notifications', icon: 'bell', perms: [] }, // clinic-wide part needs settings.manage; personal part is for everyone
  ] },
  { group: 'payments', items: [
    { key: 'payments', href: '/app/settings/payments', icon: 'wallet', perms: ['settings.manage'] },
  ] },
  { group: 'features', items: [
    { key: 'modules', href: '/app/settings/modules', icon: 'toggle-right', perms: ['settings.manage'] },
    { key: 'ai', href: '/app/settings/ai', icon: 'sparkles', perms: ['settings.manage'] },
  ] },
  { group: 'integrations', items: [
    { key: 'sheets', href: '/app/settings/google-sheets', icon: 'file-spreadsheet', perms: ['data.manage', 'data.export'] },
    { key: 'database', href: '/app/settings/database', icon: 'plug', perms: ['data.manage'] },
  ] },
  { group: 'subscription', items: [
    { key: 'subscription', href: '/app/settings/subscription', icon: 'receipt', perms: ['settings.manage'] },
  ] },
  { group: 'data', items: [
    { key: 'data', href: '/app/settings/data', icon: 'database', perms: ['audit.view', 'data.export', 'data.manage'] },
    { key: 'privacy', href: '/app/settings/privacy', icon: 'lock', perms: ['settings.manage', 'audit.view'] },
  ] },
  // Moved to the Clinic workspace (redesign 3.2/3.3); kept here for page access (settings_<key>) — the old addresses
  // redirect (team, roles) or render inside the Clinic workspace (clinical lists).
  { group: 'clinic_moved', items: [
    { key: 'team', href: '/app/clinic/team', icon: 'user-cog', perms: ['users.manage'], moved: true },
    { key: 'roles', href: '/app/clinic/roles', icon: 'shield-check', perms: ['roles.manage'], moved: true },
    { key: 'insurance', href: '/app/settings/insurance', icon: 'shield-plus', perms: ['settings.manage'], moved: true },
    { key: 'medications', href: '/app/settings/medications', icon: 'pill', perms: ['settings.manage', 'prescriptions.create'], moved: true },
    { key: 'diagnosis_codes', href: '/app/settings/diagnosis-codes', icon: 'stethoscope', perms: ['settings.manage', 'clinical.edit'], moved: true },
    { key: 'signatures', href: '/app/settings/signatures', icon: 'pen-line', perms: ['settings.manage', 'prescriptions.create'], moved: true },
  ] },
  // Personal pages (also in the user menu).
  { group: 'personal', items: [
    { key: 'account', href: '/app/settings/account', icon: 'user', perms: [] },
    { key: 'security', href: '/app/settings/security', icon: 'key-round', perms: [] },
    { key: 'appearance', href: '/app/settings/appearance', icon: 'palette', perms: [] },
  ] },
];

function sectionsFor(permissions) {
  // permissions.pagesOff: Settings sections closed for this member (per-member page access, src/modules/access).
  const off = permissions.pagesOff;
  const ok = (item) => (!item.perms.length || item.perms.some((p) => permissions.has(p))) && !(off && off.has(`settings_${item.key}`));
  return SECTIONS.map((g) => ({ group: g.group, items: g.items.filter((i) => !i.moved && ok(i)) })).filter((g) => g.items.length);
}

/** Renders a settings screen inside the settings layout (sidebar + content). */
// Screens that belong to another workspace render without the settings sidebar (team, roles, clinical lists → Clinic).
const WORKSPACE_OF = { team: 'clinic', roles: 'clinic', insurance: 'clinic', medications: 'clinic', diagnosis_codes: 'clinic', signatures: 'clinic' };
function render(req, res, view, section, data = {}) {
  return res.page(`pages/settings/${view}`, {
    workspace: WORKSPACE_OF[section] || null,
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
