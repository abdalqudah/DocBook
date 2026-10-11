// The onboarding e-mails after a clinic signs up (the welcome e-mail goes at sign-up): on day 3 how to add its
// doctors, services and hours, and on day 7 how to take online bookings. A step the clinic already did is skipped,
// each step goes once (lifecycle_emails), and only to clinics that signed up in the last 30 days — never a burst to
// older clinics. The trial / subscription ending reminders are sent by the subscriptions module.
const knex = require('../../db/knex');
const config = require('../../config');
const brand = require('../../config/brand');
const mailer = require('../../core/mailer');
const tenant = require('../../db/tenant');
const { translator } = require('../../core/i18n');

const DAY = 86_400_000;
const STEPS = [
  { key: 'day3_setup', day: 3, cta: '/app/settings', done: (s) => s.services >= 3 && s.doctors >= 1 },
  { key: 'day7_booking', day: 7, cta: '/app/settings', done: (s) => s.appointments >= 10 },
];

async function signals(businessId) {
  return tenant.runFor(businessId, async () => {
    const n = async (table) => Number(((await knex(table).where({ business_id: businessId }).count({ n: '*' }))[0] || {}).n || 0);
    return { doctors: await n('doctors'), services: await n('services'), appointments: await n('appointments') };
  });
}
async function owner(businessId) {
  return knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').join('users as u', 'u.id', 'm.user_id')
    .where({ 'm.business_id': businessId, 'r.key': 'owner', 'u.status': 'active' }).orderBy('m.id').first('u.name', 'u.email', 'u.locale');
}

/** Hourly: the steps that are due. `now` is injectable for tests. */
async function runDue(now = new Date()) {
  if (!mailer.configured()) return { sent: 0 };
  const since = new Date(now.getTime() - 30 * DAY);
  const clinics = await knex('businesses').where({ status: 'active' }).whereNot('kind', 'center_admin').where('created_at', '>=', since).select('id', 'name', 'created_at').limit(500);
  let sent = 0;
  for (const b of clinics) { // eslint-disable-line no-restricted-syntax
    const age = (now - new Date(b.created_at)) / DAY;
    const had = new Set(await knex('lifecycle_emails').where({ business_id: b.id }).pluck('step')); // eslint-disable-line no-await-in-loop
    const step = STEPS.filter((s) => age >= s.day && !had.has(s.key)).pop(); // only the latest due step: no catch-up burst
    if (!step) continue; // eslint-disable-line no-continue
    const mark = (status) => knex('lifecycle_emails').insert(STEPS.filter((s) => s.day <= step.day && !had.has(s.key)).map((s) => ({ business_id: b.id, step: s.key, status: s === step ? status : 'skipped' }))).catch(() => {});
    try {
      const o = await owner(b.id); // eslint-disable-line no-await-in-loop
      if (!o || !o.email || step.done(await signals(b.id))) { await mark('skipped'); continue; } // eslint-disable-line no-await-in-loop, no-continue
      const t = translator(o.locale === 'en' ? 'en' : 'ar');
      const vars = { name: o.name, clinic: b.name, brand: brand.name };
      const subject = t(`onb.${step.key}_subject`, vars);
      const root = String(config.appUrl).replace(/\/+$/, '');
      const hasHelp = await knex('help_articles').where({ published: true }).first('id').catch(() => null); // eslint-disable-line no-await-in-loop
      const body = `${t(`onb.${step.key}_body`, vars)}${hasHelp ? `\n\n${t('helpc.email_line', { url: `${root}/help` })}` : ''}`;
      const ok = await mailer.send({ kind: 'onboarding', to: o.email, subject, html: mailer.layout({ locale: o.locale, title: subject, body, cta: t(`onb.${step.key}_cta`), href: `${String(config.appUrl).replace(/\/+$/, '')}${step.cta}` }) }); // eslint-disable-line no-await-in-loop
      await mark(ok ? 'sent' : 'failed'); // eslint-disable-line no-await-in-loop
      if (ok) sent += 1;
    } catch (e) { await mark('failed'); } // eslint-disable-line no-await-in-loop
  }
  return { sent };
}

module.exports = { STEPS, runDue, signals };
