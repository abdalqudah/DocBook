// Shared sign-in helpers used by the regular login, sign-up, invitations and the clinic staff portal.
const knex = require('../../db/knex');
const { entryFor } = require('../rbac/permissions');

/** Starts a fresh session for `user` (session fixation safe). `businessId` pins the clinic to open. */
function signIn(req, user, { businessId } = {}) {
  return new Promise((resolve, reject) => {
    const returnTo = req.session.returnTo;
    const pendingScan = req.session.pendingScan; // attendance QR scanned before signing in
    req.session.regenerate((err) => {
      if (err) return reject(err);
      if (pendingScan) req.session.pendingScan = pendingScan;
      req.session.userId = user.id;
      req.session.businessId = businessId || user.last_business_id || null;
      req.session.returnTo = returnTo;
      req.session.ua = String(req.get('user-agent') || '').slice(0, 200);
      req.session.ip = req.ip;
      req.session.since = new Date().toISOString();
      return req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

/** Where a staff member lands in a clinic: their role's entry page (doctor → my day, nurse/reception → front desk…). */
async function landingFor(userId, businessId) {
  // Without a remembered clinic, use the first active membership (new staff accounts have none yet).
  const q = knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.user_id': userId, 'm.status': 'active' });
  if (businessId) q.where('m.business_id', businessId); else q.orderBy('m.id');
  const m = await q.first('r.key');
  if (m) return entryFor(m.key);
  // Medical reps / drug warehouses have no clinic: they work in the vendor portal.
  const v = await knex('vendor_users').where({ user_id: userId }).first('id');
  return v ? '/vendor' : '/app';
}

async function afterLogin(req, res) {
  const user = await knex('users').where({ id: req.session.userId }).first('id', 'must_change_password', 'is_platform_admin');
  // Accounts created with a temporary password choose their own first (returnTo is kept for afterwards).
  if (user && user.must_change_password) return res.redirect('/password/new');
  const to = req.session.returnTo;
  delete req.session.returnTo;
  if (to && to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/password/new')) return res.redirect(to);
  if (!req.session.businessId && user && user.is_platform_admin) {
    const any = await knex('memberships').where({ user_id: user.id, status: 'active' }).first('business_id');
    if (!any) return res.redirect('/admin');
    req.session.businessId = any.business_id;
  }
  return res.redirect(await landingFor(req.session.userId, req.session.businessId));
}

module.exports = { signIn, afterLogin, landingFor };
