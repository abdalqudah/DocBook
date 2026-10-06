// Which channels are connected right now (for the composer, the communication centre and settings).
const email = require('./email');
const sms = require('./sms');
const whatsapp = require('./whatsapp');

async function status() {
  const [e, s, w] = await Promise.all([email.currentConfig(), sms.currentConfig(), whatsapp.currentConfig()]);
  return { email: !!(e && e.host && e.fromEmail), sms: !!s, whatsapp: !!w };
}

module.exports = { status, CHANNELS: ['email', 'sms', 'whatsapp'] };
