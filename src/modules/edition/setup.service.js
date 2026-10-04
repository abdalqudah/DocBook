// First start of a single-clinic / single-centre installation (src/config/edition.js): when there is no clinic yet,
// it is created from .env (CLINIC_NAME, CLINIC_SLUG, CLINIC_CURRENCY, CLINIC_TIMEZONE, CLINIC_CITY) and given to the
// installation's own account (SUPER_ADMIN_EMAIL) as its owner. A centre gets its administration account and the
// centre itself; the doctors' clinics are then added from the centre's pages. Never touches an existing clinic.
const knex = require('../../db/knex');
const edition = require('../../config/edition');
const config = require('../../config');

async function ensure() {
  if (!edition.single) return null;
  const k = knex.main;
  const q = k('businesses').whereNot('status', 'deleted');
  const existing = edition.center ? await q.where({ kind: 'center_admin' }).first('id') : await q.whereNot('kind', 'center_admin').whereNull('center_id').first('id');
  if (existing) return existing.id;
  const email = config.superAdmin && config.superAdmin.email;
  const owner = email ? await k('users').where({ email }).first('id') : null;
  if (!owner) {
    console.warn('[setup] SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD are needed to create the clinic at first start.'); // eslint-disable-line no-console
    return null;
  }
  const businesses = require('../businesses/business.service'); // eslint-disable-line global-require
  const centers = require('../center/center.service'); // eslint-disable-line global-require
  const options = require('../settings/options'); // eslint-disable-line global-require
  const s = edition.setup;
  const name = s.name || (edition.center ? 'المركز الطبي' : 'العيادة');
  const bid = await knex.transaction(async (trx) => {
    const id = await businesses.create(owner.id, { name, currency: s.currency, timezone: s.timezone, city: s.city, country: options.countryForZone(s.timezone) }, trx);
    if (s.nameEn) await trx('businesses').where({ id }).update({ name_en: s.nameEn });
    if (edition.center) {
      await centers.create({ businessId: id, userId: owner.id }, { name, name_en: s.nameEn || undefined }, trx);
      await trx('businesses').where({ id }).update({ kind: 'center_admin', onboarding_completed_at: new Date() });
    }
    const slug = businesses.normalizeSlug(s.slug || '');
    if (slug && !businesses.validateSlug(slug) && !(await trx('businesses').where({ slug }).whereNot({ id }).first('id'))) await trx('businesses').where({ id }).update({ slug });
    return id;
  });
  businesses.forget(bid);
  console.log(`[setup] ${edition.center ? 'medical centre' : 'clinic'} "${name}" created`); // eslint-disable-line no-console
  return bid;
}

module.exports = { ensure };
