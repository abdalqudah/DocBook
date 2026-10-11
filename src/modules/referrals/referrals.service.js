// Clinic referrals: every clinic has an invitation link (/signup?ref=CODE). A clinic that signs up through it is
// marked as referred (and its CRM contact's source is "referral"); when it pays its first subscription invoice, the
// clinic that invited it gets one free month — added to its running period, or to its trial, or kept as a credit
// the platform admin applies by hand when it has neither. One reward per referred clinic.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');

const CODE_RE = /^[A-Z0-9]{6,16}$/;
const newCode = () => crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8).padEnd(8, '7');

/** The clinic's invitation code (made the first time it is asked for). */
async function codeFor(businessId) {
  const b = await knex('businesses').where({ id: businessId }).first('referral_code');
  if (b && b.referral_code) return b.referral_code;
  for (let i = 0; i < 5; i += 1) {
    const code = newCode();
    try {
      const n = await knex('businesses').where({ id: businessId }).whereNull('referral_code').update({ referral_code: code }); // eslint-disable-line no-await-in-loop
      if (n) return code;
      return (await knex('businesses').where({ id: businessId }).first('referral_code')).referral_code; // eslint-disable-line no-await-in-loop
    } catch { /* taken: try another */ }
  }
  throw new Error('Could not make a referral code');
}
const cleanCode = (v) => { const c = String(v || '').trim().toUpperCase(); return CODE_RE.test(c) ? c : null; };

/** A new clinic signed up with a code: remember who invited it. */
async function attach(businessId, code) {
  const c = cleanCode(code);
  if (!c) return false;
  const ref = await knex('businesses').where({ referral_code: c }).first('id');
  if (!ref || ref.id === businessId) return false;
  const n = await knex('businesses').where({ id: businessId }).whereNull('referred_by').update({ referred_by: ref.id });
  if (n) await knex('crm_contacts').where({ business_id: businessId }).update({ source: 'referral' }).catch(() => {});
  return Boolean(n);
}

function addMonth(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** A subscription invoice was paid: the first one of a referred clinic rewards the clinic that invited it. */
async function onPaid(businessId, invoiceId) {
  const b = await knex('businesses').where({ id: businessId }).first('id', 'name', 'referred_by');
  if (!b || !b.referred_by) return null;
  if (await knex('referral_rewards').where({ referred_id: b.id }).first('id')) return null;
  const sub = await knex('clinic_subscriptions').where({ business_id: b.referred_by }).first();
  const today = new Date().toISOString().slice(0, 10);
  let applied = 'credit';
  if (sub && sub.status === 'active' && sub.current_period_end) {
    await knex('clinic_subscriptions').where({ id: sub.id }).update({ current_period_end: addMonth(sub.current_period_end), updated_at: new Date() });
    applied = 'period';
  } else if (sub && sub.status === 'trialing' && sub.trial_ends_at && String(sub.trial_ends_at).slice(0, 10) >= today) {
    await knex('clinic_subscriptions').where({ id: sub.id }).update({ trial_ends_at: addMonth(sub.trial_ends_at), updated_at: new Date() });
    applied = 'trial';
  }
  try { await knex('referral_rewards').insert({ referrer_id: b.referred_by, referred_id: b.id, invoice_id: invoiceId || null, applied }); } catch { return null; } // a second payment at the same moment
  await audit.record({ businessId: b.referred_by, userId: null }, 'referral.rewarded', { entityType: 'business', entityId: b.referred_by, newValues: { referred: b.name, applied } });
  const owners = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.business_id': b.referred_by, 'r.key': 'owner', 'm.status': 'active' }).pluck('m.user_id');
  const { translator } = require('../../core/i18n'); // eslint-disable-line global-require
  const notify = require('../notifications/notification.service'); // eslint-disable-line global-require
  for (const uid of owners) { // eslint-disable-line no-restricted-syntax
    const u = await knex('users').where({ id: uid }).first('locale'); // eslint-disable-line no-await-in-loop
    const t = translator(u && u.locale === 'en' ? 'en' : 'ar');
    await notify.notify(b.referred_by, { userId: uid, type: 'referral.rewarded', title: t('ref.reward_title'), body: t(`ref.reward_${applied}`, { clinic: b.name }), link: '/app/settings/subscription#referral', severity: 'success', dedupeKey: `ref:${b.id}:${uid}` }).catch(() => {}); // eslint-disable-line no-await-in-loop
  }
  if (applied === 'credit') await require('../platformnotify/notify.service').admin('referral_credit', { clinic: b.name }, { link: `/admin/clinics/${b.referred_by}`, severity: 'warning' }).catch(() => {}); // eslint-disable-line global-require
  return applied;
}

async function summary(businessId) {
  const [signed, rewarded] = await Promise.all([
    knex('businesses').where({ referred_by: businessId }).count({ n: '*' }).then((r) => Number(r[0].n)),
    knex('referral_rewards').where({ referrer_id: businessId }).count({ n: '*' }).then((r) => Number(r[0].n)),
  ]);
  return { code: await codeFor(businessId), signed, rewarded };
}

module.exports = { codeFor, cleanCode, attach, onPaid, summary, addMonth };
