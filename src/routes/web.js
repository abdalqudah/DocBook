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
router.use('/verify', require('../modules/certificates/verify.web')); // public check of sick leaves / medical reports (QR)
router.use('/kiosk', require('../modules/attendance/kiosk.web')); // attendance door screen, opened by its own secret link (no staff sign-in on the door tablet)
router.use('/calendar', require('../modules/live/public.web')); // a doctor's private iCal subscription (/calendar/<token>.ics)
router.use('/m', require('../modules/integrations/public.web')); // public images of a clinic's media library (/m/<slug>/<id>)
// Clinic pages (docbook/<slug>, /<slug>/login, /<slug>/book…) come LAST so they never shadow a platform path;
// every top-level path the platform uses is also in businesses.RESERVED so no clinic can take it.
// Online consultations: the patient's consultation page (/c/<token>) and online booking (/<slug>/book/online).
router.use('/', require('../modules/discover/public.web')); // clinic directory (/clinics), /widget.js, widget booking confirmation
router.use('/c', require('../modules/payments/patient.web')); // "Pay online" + "Your documents" on /c/<token> (before telehealth)
router.use('/c', require('../modules/telehealth/public.web'));
router.use('/pay', require('../modules/payments/public.web')); // card payment pages (/pay/<id>, HyperPay return)
router.use('/d', require('../modules/share/web').pub); // documents sent to patients by secure link (/d/<token>)
router.use('/', require('../modules/messaging/public.web')); // patient links from messages: /r/<token> (confirm/cancel/reschedule), /review/<token>
router.use('/', require('../modules/telehealth/booking.web'));
router.use('/', require('../modules/site/booking.web'));
router.use('/', require('../modules/site/portal.web'));
module.exports = router;
