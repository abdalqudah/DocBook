// On signup (a clinic, a medical centre, a drug warehouse or rep): the account joins the CRM with a "signed up" entry on
// its timeline, and its owner gets a welcome e-mail from the platform (logged in Admin → E-mail log). Best effort: a
// failure here never blocks the signup.
const knex = require('../../db/knex');
const brand = require('../../config/brand');
const mailer = require('../../core/mailer');
const { translator } = require('../../core/i18n');
const crm = require('./crm.service');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** { businessId } or { vendorId }, the owner { name, email, locale }, the site's base URL. */
async function onSignup({ businessId = null, vendorId = null, owner, base = '' }) {
  try {
    await crm.sync();
    const contact = await knex('crm_contacts').where(businessId ? { business_id: businessId } : { vendor_id: vendorId }).first('id', 'organization');
    const org = contact ? contact.organization : '';
    if (contact) await crm.log({}, contact.id, 'event', translator('ar')('sales.signup_event', { name: org || owner.name }));
    if (!owner || !owner.email) return;
    const t = translator(owner.locale === 'en' ? 'en' : 'ar');
    const vars = { brand: brand.name, name: owner.name, clinic: org || owner.name };
    const subject = t('sales.welcome_subject', vars);
    const body = t(vendorId ? 'sales.vendor_welcome_body' : 'sales.welcome_body', vars);
    const sent = await mailer.send({
      kind: 'welcome', to: owner.email, subject,
      html: mailer.layout({ locale: owner.locale, title: subject, body: esc(body).replace(/\n/g, '<br>'), cta: t('sales.welcome_cta'), href: `${String(base).replace(/\/+$/, '')}${vendorId ? '/vendor' : '/app'}` }),
    });
    if (sent && contact) await crm.log({}, contact.id, 'email', `${subject}\n\n${body}`, 'sent').catch(() => {});
  } catch (e) { /* best effort */ }
}

module.exports = { onSignup };
