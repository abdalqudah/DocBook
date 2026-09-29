// Vendor (medical rep / drug warehouse) portal context: the signed-in user must belong to a vendor account.
// Sets req.vendor (the vendor row) and req.vendorCtx { vendorId, userId, role }. Pending vendors can sign in and
// prepare their profile/products, but nothing reaches clinics until the platform approves them (status 'active').
const knex = require('../db/knex');
const { E } = require('../core/errors');

async function requireVendor(req, res, next) {
  try {
    if (!req.user) { if (req.method === 'GET') req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
    if (req.user.must_change_password) return res.redirect('/password/new');
    const m = await knex('vendor_users as vu').join('vendors as v', 'v.id', 'vu.vendor_id').where({ 'vu.user_id': req.user.id })
      .whereNot('v.status', 'suspended').orderBy('vu.id').first('v.*', 'vu.role as member_role');
    if (!m) return next(E.forbidden('vendor'));
    const { member_role: role, ...vendor } = m;
    req.vendor = vendor;
    req.vendorCtx = { vendorId: vendor.id, userId: req.user.id, role, ip: req.ip, userAgent: req.get('user-agent') };
    res.locals.vendor = vendor;
    return next();
  } catch (err) { return next(err); }
}

module.exports = { requireVendor };
