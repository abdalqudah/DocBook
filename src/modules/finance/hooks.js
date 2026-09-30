// Budget alerts after money goes out elsewhere in the app: when an expense is saved (/app/expenses…) or a doctor's
// month is marked paid (/app/payroll/doctors/:id/pay), the clinic's budgets for the current month are checked once the
// response has been sent (never slows down or breaks the request). Mount BEFORE the /expenses and /payroll routers:
//   router.use(require('../modules/finance/hooks'));
const budgets = require('./budgets.service');

const WATCH = [/^\/expenses(\/\d+)?\/?$/, /^\/payroll\/doctors\/\d+\/pay\/?$/];

module.exports = function financeBudgetHook(req, res, next) {
  if (req.method === 'POST' && req.ctx && req.ctx.businessId && WATCH.some((re) => re.test(req.path))) {
    const { businessId, timezone } = req.ctx;
    res.on('finish', () => { if (res.statusCode < 400) budgets.checkNow(businessId, timezone); });
  }
  next();
};
