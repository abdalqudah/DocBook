// Help center for clinic staff: FAQ by topic (texts in locales/*/ops.json → help.sections) and a support contact
// that only appears when SUPPORT_EMAIL is configured.
const express = require('express');
const { dictionaries } = require('../../core/i18n');
const perms = require('../rbac/permissions');

const router = express.Router();

// Where each topic leads in the app, shown only to people who can open it.
const LINKS = {
  appointments: { href: '/app/appointments', nav: 'appointments', perms: ['appointments.view'] },
  'front-desk': { href: '/app/front-desk', nav: 'front_desk', perms: ['frontdesk.use'] },
  doctors: { href: '/app/doctors', nav: 'doctors', perms: ['doctors.manage', 'appointments.view_all'] },
  roles: { href: '/app/settings/team', nav: 'team', perms: ['users.manage'] },
  clinical: { href: '/app/patients', nav: 'patients', perms: ['patients.view'] },
  payroll: { href: '/app/payroll', nav: 'payroll', perms: ['payroll.view'] },
  supplies: { href: '/app/supplies', nav: 'supplies', perms: ['supplies.view'] },
};

function roleSummaries() {
  return perms.SYSTEM_ROLES.map((r) => {
    const set = new Set(perms.normalise(r.permissions));
    const missing = perms.ALL.filter((p) => !set.has(p));
    const groups = perms.GROUPS.map((g) => ({ key: g.key, perms: g.perms.filter((p) => set.has(p)) })).filter((g) => g.perms.length);
    return { key: r.key, entry: r.entry, all: missing.length === 0, missing: missing.length <= 3 ? missing : null, groups };
  });
}

router.get('/', (req, res) => {
  const dict = dictionaries[req.locale] || dictionaries.en;
  const sections = (dict.help && dict.help.sections) || dictionaries.en.help.sections;
  const has = (list) => list.some((p) => req.ctx.permissions.has(p));
  const links = Object.fromEntries(Object.entries(LINKS).filter(([, l]) => has(l.perms)).map(([k, l]) => [k, l]));
  const email = String(process.env.SUPPORT_EMAIL || '').trim();
  res.page('pages/help/index', {
    title: req.t('help.title'), sections, links, roles: roleSummaries(),
    // Permission keys contain dots, so they are looked up directly rather than through t().
    permLabel: (p) => (dict.perms && dict.perms[p]) || (dictionaries.en.perms || {})[p] || p,
    supportEmail: /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email) ? email : null,
    pageScripts: ['/js/ops.js'], pageStyles: ['/css/ops.css'],
  });
});

module.exports = router;
