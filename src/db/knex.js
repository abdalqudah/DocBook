// The database everyone queries. It behaves exactly like a knex instance, and sends each query to the database of the
// current clinic (or medical centre) — its own database when it has one, the main database otherwise; see tenant.js.
//   knex('patients')…         the current clinic's database
//   knex.main('users')…       always the main database
const tenant = require('./tenant');

const extra = {
  main: tenant.main,
  tenant,
  destroy: () => tenant.destroyAll(),
};

const knex = new Proxy(function knexProxy() {}, {
  apply(_t, _this, args) { return tenant.active()(...args); },
  get(_t, prop) {
    if (Object.prototype.hasOwnProperty.call(extra, prop)) return extra[prop];
    if (prop === 'migrate') return tenant.TEST_DB ? require('./tenant-test').migrator(tenant.main.migrate) : tenant.main.migrate; // eslint-disable-line global-require -- migrations always run on the main database (tenant-admin.syncAll follows)
    const k = tenant.active();
    const v = k[prop];
    return typeof v === 'function' && prop !== 'constructor' ? v.bind(k) : v;
  },
  has(_t, prop) { return prop in extra || prop in tenant.active(); },
});

module.exports = knex;
