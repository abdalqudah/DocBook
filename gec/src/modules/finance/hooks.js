// Stripe webhook: only events with a valid Stripe-Signature are processed (Settings → Payments → webhook secret).
const hooks = require('../hooks.web');
const online = require('./online');

hooks.post('/stripe', async (req, res) => {
  const c = await online.currentConfig().catch(() => null);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!c || !c.webhookSecret || !online.validSignature(c.webhookSecret, raw, req.get('stripe-signature'))) return res.sendStatus(400);
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
  try {
    const result = await online.handleEvent(event);
    return res.json({ received: true, result });
  } catch (e) {
    console.error('[hooks/stripe]', e.message); // eslint-disable-line no-console
    return res.sendStatus(500); // Stripe retries; recording is idempotent
  }
});

module.exports = hooks;
