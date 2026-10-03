// Vendor (medical rep / drug warehouse) portal context: the signed-in user must belong to a vendor account.
// Sets req.vendor (the vendor row) and req.vendorCtx { vendorId, userId, role }. Pending vendors can sign in and
// prepare their profile/products, but nothing reaches clinics until the platform approves them (status 'active').
const knex = require('../db/knex');

async function requireVendor(req, res, next) {
  try {
    if (!req.user) { if (req.method === 'GET') req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
    if (req.user.must_change_password) return res.redirect('/password/new');
    const m = await knex('vendor_users as vu').join('vendors as v', 'v.id', 'vu.vendor_id').where({ 'vu.user_id': req.user.id })
      .orderBy('vu.id').first('v.*', 'vu.role as member_role');
    // Signed in but not a rep/warehouse yet: offer to register this account as one.
    if (!m) return res.redirect('/vendors/signup');
    if (m.status === 'suspended') {
      return res.status(403).page('pages/auth/message', { layout: 'auth', title: req.t('vendor_guard.suspended_title'), heading: req.t('vendor_guard.suspended_title'), text: req.t('vendor_guard.suspended_text') });
    }
    const { member_role: role, ...vendor } = m;
    req.vendor = vendor;
    req.vendorCtx = { vendorId: vendor.id, userId: req.user.id, role, ip: req.ip, userAgent: req.get('user-agent') };
    res.locals.vendor = vendor;
    // Sidebar counters: new purchase orders from clinics and visit requests still awaiting the clinic's answer are
    // only relevant once the vendor is approved.
    res.locals.vendorBadges = { orders: 0 };
    if (vendor.status === 'active') {
      const [{ n }] = await knex('purchase_orders').where({ vendor_id: vendor.id, status: 'sent' }).count({ n: '*' });
      res.locals.vendorBadges.orders = Number(n);
    }
    // Reps billing (when the platform turned it on): trial / expiry banner.
    const billing = require('../modules/vendorbilling/billing.service'); // eslint-disable-line global-require
    const st = await billing.state(vendor.id);
    res.locals.pnUnread = await require('../modules/platformnotify/notify.service').unread('vendor', vendor.id); // eslint-disable-line global-require
    res.locals.vbill = st.enabled ? { status: st.status, ok: st.ok, daysLeft: st.daysLeft } : null;
    return next();
  } catch (err) { return next(err); }
}

module.exports = { requireVendor };
