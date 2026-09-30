// Subscription gate for /app (worker: subscriptions). Mounted by src/routes/app.js after the nav middleware.
// Sets res.locals.subscriptionBanner; must call next() for everything while subscriptions are disabled.
module.exports = (req, res, next) => next();
