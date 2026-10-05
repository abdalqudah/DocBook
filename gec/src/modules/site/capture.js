// Turns a public form submission into a CRM lead with attribution and consent. Shared by every website form
// (consultation, contact, program / university / scholarship enquiries, events, downloads, newsletter).
const leads = require('../crm/leads.service');
const events = require('../../core/events');

const UTM = ['source', 'medium', 'campaign', 'term', 'content'];

/** Attribution for this request: tracked visitor (when consented), else hidden form fields, else the referrer. */
function originOf(req, source, extra = {}) {
  const b = req.body || {};
  const v = req.visitor || null; // set by the growth module when analytics consent was given
  const utm = {};
  UTM.forEach((k) => { const val = (v && v.utm && v.utm[k]) || b[`utm_${k}`]; if (val) utm[k] = String(val).slice(0, 160); });
  return {
    source, sourceDetail: extra.sourceDetail || null, utm,
    landingPage: (v && v.landing_page) || (b.landing_page ? String(b.landing_page).slice(0, 500) : String(req.get('referer') || '').slice(0, 500)) || null,
    referrer: (v && v.referrer) || (b.referrer ? String(b.referrer).slice(0, 500) : null),
    visitorId: v ? v.id : null, firstVisitAt: v ? v.first_seen_at : null, lastVisitAt: v ? v.last_seen_at : null,
    consent: { contact: true, marketing: b.consent_marketing === '1' || b.consent_marketing === 'on' || b.consent_marketing === true },
  };
}

/** Bots fill hidden fields. A filled honeypot is accepted silently (no lead), so bots learn nothing. */
const isBot = (req) => Boolean(req.body && (req.body.website || req.body.company_url));

async function submit(req, source, data, extra = {}) {
  const { lead, created } = await leads.capture({ userId: req.user ? req.user.id : null, ip: req.ip, userAgent: req.get('user-agent') }, data, originOf(req, source, extra));
  await events.emit('site.lead_captured', { req, lead, created, source });
  if (req.session) req.session.leadId = lead.id; // lets later pages (thank-you, sign-up) prefill without asking again
  return { lead, created };
}

module.exports = { submit, originOf, isBot, UTM };
