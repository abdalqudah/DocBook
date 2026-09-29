const express = require('express');
const { requireAuth, resolveBusiness } = require('../middleware/context');
const site = require('../modules/site/web');

const router = express.Router();
router.use(site.chrome); // header/footer content of the public pages
router.use('/', site);
router.use('/', require('../modules/auth/web'));
router.use('/app', requireAuth, resolveBusiness, require('./app'));
router.use('/admin', require('../modules/admin/web'));
// Medical reps & drug warehouses: public sign-up/landing (/vendors) and their portal (/vendor).
router.use('/vendors', require('../modules/vendors/public.web'));
{
  const { requireVendor } = require('../middleware/vendor'); // eslint-disable-line global-require
  const vendor = express.Router();
  vendor.use(requireVendor);
  vendor.use('/visits', require('../modules/marketplace/vendor-visits.web'));
  vendor.use('/orders', require('../modules/purchasing/vendor-orders.web'));
  vendor.use('/', require('../modules/vendors/web'));
  router.use('/vendor', vendor);
}
// Clinic pages (docbook/<slug>, /<slug>/login, /<slug>/book…) come LAST so they never shadow a platform path;
// every top-level path the platform uses is also in businesses.RESERVED so no clinic can take it.
// Online consultations: the patient's consultation page (/c/<token>) and online booking (/<slug>/book/online).
router.use('/c', require('../modules/telehealth/public.web'));
router.use('/', require('../modules/telehealth/booking.web'));
router.use('/', require('../modules/site/booking.web'));
router.use('/', require('../modules/site/portal.web'));
module.exports = router;
