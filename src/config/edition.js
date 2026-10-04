// Installation type, from .env (APP_EDITION):
//   platform  many clinics sign up on one site (the default)
//   clinic    one clinic: its website is the home page (/), its management behind /admin
//   center    one medical centre: the centre's website is the home page, each doctor's clinic keeps its own site
//             under /<clinic address>, the management behind /admin
// A single clinic or centre has no public sign-up, no clinic directory, no pricing pages and no reps' portal.
// Read .env first: this file can be loaded before src/config/index.js (dotenv never overrides what is set).
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true }); // eslint-disable-line global-require

const EDITION = ['clinic', 'center'].includes(String(process.env.APP_EDITION || '').toLowerCase()) ? String(process.env.APP_EDITION).toLowerCase() : 'platform';

const single = EDITION !== 'platform';
/** The installation's own clinic (one clinic) or centre administration (one centre): its website is the domain itself. */
const isMain = (b) => Boolean(single && b && (EDITION === 'center' ? b.kind === 'center_admin' : !b.center_id && b.kind !== 'center_admin'));
/** A clinic's public address: the domain for the installation's own clinic, else <base>/<slug>. */
const siteUrl = (base, b) => (isMain(b) ? String(base || '').replace(/\/+$/, '') || '/' : `${base || ''}/${b.slug}`);

module.exports = {
  isMain,
  siteUrl,
  EDITION,
  single: EDITION !== 'platform',
  center: EDITION === 'center',
  // The clinic / centre created at first start (when there is none yet).
  setup: {
    name: (process.env.CLINIC_NAME || '').trim(),
    nameEn: (process.env.CLINIC_NAME_EN || '').trim(),
    slug: (process.env.CLINIC_SLUG || '').trim().toLowerCase(),
    currency: (process.env.CLINIC_CURRENCY || 'JOD').trim().toUpperCase(),
    timezone: (process.env.CLINIC_TIMEZONE || 'Asia/Amman').trim(),
    city: (process.env.CLINIC_CITY || '').trim() || null,
  },
};
