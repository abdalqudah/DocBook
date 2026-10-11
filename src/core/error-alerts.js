// Server errors (500) told to the platform admins: a notification in Admin, and an e-mail to each admin when the
// platform's e-mail is set up — at most one every 30 minutes, with how many happened since and the latest one (path
// and message only: no request body, no patient data). Never throws.
const config = require('../config');

const WINDOW = 30 * 60_000;
let lastAt = 0;
let pending = 0;

function report(req, err) {
  try {
    if (config.isTest && !report.enabledInTests) return;
    pending += 1;
    const now = Date.now();
    if (now - lastAt < WINDOW) return;
    lastAt = now;
    const n = pending; pending = 0;
    const path = String(req.originalUrl || '').split('?')[0].replace(/\d{4,}/g, ':n').slice(0, 120);
    const message = String((err && err.message) || err || '').split('\n')[0].slice(0, 200);
    setImmediate(async () => {
      try {
        await require('../modules/platformnotify/notify.service').admin('server_error', { n, path, message }, { link: '/admin', severity: 'warning' }); // eslint-disable-line global-require
        const mailer = require('./mailer'); // eslint-disable-line global-require
        if (!mailer.configured()) return;
        const knex = require('../db/knex'); // eslint-disable-line global-require
        const admins = await knex('users').where({ is_platform_admin: true, status: 'active' }).select('email', 'locale');
        const brand = require('../config/brand'); // eslint-disable-line global-require
        await Promise.all(admins.map((a) => {
          const ar = a.locale !== 'en';
          const title = ar ? `${brand.name}: خطأ في الخادم (${n})` : `${brand.name}: server error (${n})`;
          const body = ar ? `صار ${n} خطأ بالخادم آخر فترة.\nآخر واحد: ${req.method} ${path}\n${message}` : `${n} server error(s) recently.\nLatest: ${req.method} ${path}\n${message}`;
          return mailer.send({ kind: 'server_error', to: a.email, subject: title, html: mailer.layout({ locale: ar ? 'ar' : 'en', title, body }) }).catch(() => {});
        }));
      } catch { /* never breaks anything */ }
    });
  } catch { /* never breaks anything */ }
}
report.enabledInTests = false;
report.reset = () => { lastAt = 0; pending = 0; };

module.exports = { report };
