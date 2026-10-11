// "Book a demo" on the platform's site (/demo): a clinic leaves its details and lands in the CRM as a prospect from
// the website, with the request on its timeline and a follow-up due today; the platform admin is notified. The same
// person asking again (same e-mail, or the same phone's last 8 digits) is the same contact: the request is added to it.
const knex = require('../../db/knex');
const { E } = require('../../core/errors');

const CHOICES = { doctors: 4, current: 4, when: 4, how: 3 }; // indexes into the option lists of mkt.demo.*_opts
const str = (v, n) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,24}$/;

/** Checks the form → the clean request, or E.validation with the field errors (messages from mkt.demo.err_*). */
function clean(body, t) {
  const r = {
    name: str(body.name, 120), clinic: str(body.clinic, 190), phone: str(body.phone, 40), email: str(body.email, 190).toLowerCase(),
    country: /^[A-Za-z]{2}$/.test(String(body.country || '')) ? String(body.country).toUpperCase() : null, city: str(body.city, 120),
    specialty: str(body.specialty, 120), message: String(body.message || '').trim().slice(0, 2000),
  };
  Object.keys(CHOICES).forEach((k) => { const i = Number(body[k]); r[k] = Number.isInteger(i) && i >= 0 && i < CHOICES[k] ? i : null; });
  const errors = {};
  if (!r.name) errors.name = t('mkt.demo.err_name');
  if (!r.clinic) errors.clinic = t('mkt.demo.err_clinic');
  if (!r.phone && !r.email) errors.phone = t('mkt.demo.err_contact');
  if (r.phone && r.phone.replace(/\D/g, '').length < 8) errors.phone = t('mkt.demo.err_phone');
  if (r.email && !EMAIL.test(r.email)) errors.email = t('mkt.demo.err_email');
  if (Object.keys(errors).length) throw E.validation(errors);
  return r;
}

/** The request as text for the CRM timeline (in the language the admin reads the site in, the visitor's choices). */
function summary(r, t, opts) {
  const pick = (k) => (r[k] === null ? null : (opts[`${k}_opts`] || [])[r[k]]);
  return [
    t('mkt.demo.nav'),
    `${t('mkt.demo.clinic')}: ${r.clinic}`,
    r.specialty && `${t('mkt.demo.specialty')}: ${r.specialty}`,
    pick('doctors') && `${t('mkt.demo.doctors')}: ${pick('doctors')}`,
    pick('current') && `${t('mkt.demo.current')}: ${pick('current')}`,
    pick('how') && `${t('mkt.demo.how')}: ${pick('how')}`,
    pick('when') && `${t('mkt.demo.when')}: ${pick('when')}`,
    r.message && `\n${r.message}`,
  ].filter(Boolean).join('\n');
}

/** Saves a demo request → { contactId, isNew }. */
async function request(body, { t, opts, ip = null }) {
  const r = clean(body, t);
  const digits = r.phone.replace(/\D/g, '').slice(-8);
  const bare = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col}, ''), ' ', ''), '-', ''), '+', ''), '(', '')`;
  const same = await knex('crm_contacts').whereNull('business_id').whereNull('vendor_id').where((w) => {
    if (r.email) w.orWhereRaw('LOWER(email) = ?', [r.email]);
    if (digits.length === 8) w.orWhereRaw(`${bare('phone')} LIKE ?`, [`%${digits}`]).orWhereRaw(`${bare('whatsapp')} LIKE ?`, [`%${digits}`]);
  }).orderBy('id').first('id', 'stage');
  const now = new Date();
  let contactId = same && same.id;
  if (contactId) {
    await knex('crm_contacts').where({ id: contactId }).update({ next_action_at: now, next_action: t('mkt.demo.nav'), updated_at: now });
  } else {
    [contactId] = await knex('crm_contacts').insert({
      kind: 'prospect', name: r.name, organization: r.clinic, phone: r.phone || null, whatsapp: r.phone || null, email: r.email || null,
      country: r.country, city: r.city || null, stage: 'new', source: 'website', next_action_at: now, next_action: t('mkt.demo.nav'),
      notes: r.specialty || null,
    });
  }
  await knex('crm_activities').insert({ contact_id: contactId, kind: 'event', body: summary(r, t, opts).slice(0, 8000), status: null, user_id: null });
  await require('../platformnotify/notify.service').admin('demo_request', { name: r.name, clinic: r.clinic }, { link: `/admin/crm/${contactId}`, severity: 'success' }); // eslint-disable-line global-require
  await require('../../core/audit').record({ userId: null, businessId: null, ip }, 'crm.demo_requested', { entityType: 'crm_contact', entityId: contactId, newValues: { clinic: r.clinic, existing: Boolean(same) } }).catch(() => {}); // eslint-disable-line global-require
  return { contactId, isNew: !same };
}

module.exports = { request, clean };
