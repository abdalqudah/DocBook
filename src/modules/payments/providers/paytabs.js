// PayTabs — "Hosted Payment Page" (PT2 API). https://support.paytabs.com (Developer → PT2 API endpoints)
//   create:  POST {region}/payment/request   (tran_type sale, tran_class ecom, callback + return URLs) → redirect_url
//   verify:  POST {region}/payment/query     { profile_id, tran_ref } → payment_result.response_status 'A' = approved
//   refund:  POST {region}/payment/request   (tran_type refund, the original tran_ref)
//   callback (server → server): JSON body, header "Signature" = HMAC-SHA256(raw body, server key)
//   return   (browser POST):   form fields + "signature" = HMAC-SHA256(sorted, non-empty fields as a query string)
// Authentication: the "authorization" header carries the profile's server key. Test and live use the same
// endpoints — a test profile only accepts test cards.
const crypto = require('crypto');
const { request } = require('./http');
const { AppError } = require('../../../core/errors');

const REGIONS = {
  JOR: 'https://secure-jordan.paytabs.com',
  ARE: 'https://secure.paytabs.com',
  SAU: 'https://secure.paytabs.sa',
  EGY: 'https://secure-egypt.paytabs.com',
  OMN: 'https://secure-oman.paytabs.com',
  GLOBAL: 'https://secure-global.paytabs.com',
};

const STATUS = { A: 'paid', H: 'pending', P: 'pending', V: 'failed', E: 'failed', D: 'failed', X: 'failed', C: 'cancelled', '': 'failed' };

/** PHP urlencode(), which http_build_query() uses (space → "+", everything but [A-Za-z0-9_.-] escaped). */
const phpEncode = (s) => encodeURIComponent(String(s)).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');

const hmac = (key, data) => crypto.createHmac('sha256', String(key)).update(data).digest('hex');
const sameHex = (a, b) => {
  const x = Buffer.from(String(a || '').toLowerCase(), 'utf8');
  const y = Buffer.from(String(b || '').toLowerCase(), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/** Amount as PayTabs expects it: a number with at most 3 decimals. */
const amountOf = (v) => Math.round(Number(v) * 1000) / 1000;

/** Outside production a local simulator can stand in for PayTabs (PAYTABS_BASE_URL) — never in production. */
const override = () => (process.env.NODE_ENV !== 'production' && /^https?:\/\/[^\s]+$/.test(process.env.PAYTABS_BASE_URL || '') ? process.env.PAYTABS_BASE_URL.replace(/\/+$/, '') : null);

function client(creds) {
  const base = (REGIONS[creds.region] && override()) || REGIONS[creds.region] || null;
  if (!base || !creds.profileId || !creds.serverKey) throw new AppError('PAY_NOT_CONFIGURED', 'PayTabs is not configured.', 409);
  const profileId = Number(creds.profileId);
  const post = (path, body) => request(`${base}${path}`, {
    method: 'POST', headers: { authorization: creds.serverKey, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
  });

  /** Normalised result of a PayTabs transaction object (query answer or callback body). */
  function normalise(j) {
    const pr = (j && j.payment_result) || {};
    const code = String(pr.response_status || '');
    return {
      status: STATUS[code] || 'failed', code: code || String((j && j.code) || ''), message: String(pr.response_message || (j && j.message) || '').slice(0, 250),
      ref: j && j.tran_ref ? String(j.tran_ref) : null, cartId: j && j.cart_id ? String(j.cart_id) : null,
      amount: j && j.cart_amount !== undefined ? amountOf(j.cart_amount) : null, currency: j && j.cart_currency ? String(j.cart_currency).toUpperCase() : null,
      tranType: j && j.tran_type ? String(j.tran_type).toLowerCase() : null,
      raw: j ? { tran_ref: j.tran_ref, tran_type: j.tran_type, cart_id: j.cart_id, cart_amount: j.cart_amount, cart_currency: j.cart_currency, tran_total: j.tran_total, tran_currency: j.tran_currency, payment_result: pr, card_scheme: j.payment_info && j.payment_info.card_scheme, payment_method: j.payment_info && j.payment_info.payment_method } : null,
    };
  }

  return {
    provider: 'paytabs', base,

    /** Creates the hosted payment page. → { ref, redirectUrl } */
    async createPayment({ cartId, amount, currency, description, customer = {}, callbackUrl, returnUrl, lang }) {
      const body = {
        profile_id: profileId, tran_type: 'sale', tran_class: 'ecom', cart_id: cartId, cart_currency: currency, cart_amount: amountOf(amount),
        cart_description: String(description || cartId).slice(0, 100), paypage_lang: lang === 'en' ? 'en' : 'ar', hide_shipping: true,
        callback: callbackUrl, return: returnUrl,
        customer_details: Object.fromEntries(Object.entries({ name: customer.name, email: customer.email, phone: customer.phone, country: customer.country }).filter(([, v]) => v)),
      };
      const r = await post('/payment/request', body);
      if (r.status >= 400 || !r.json || !r.json.redirect_url || !r.json.tran_ref) {
        throw new AppError('PAY_PROVIDER_ERROR', `PayTabs: ${(r.json && r.json.message) || `HTTP ${r.status}`}`, 502);
      }
      return { ref: String(r.json.tran_ref), redirectUrl: String(r.json.redirect_url) };
    },

    /** Asks PayTabs for the real state of a transaction (never trust the browser). */
    async verify(tranRef) {
      const r = await post('/payment/query', { profile_id: profileId, tran_ref: tranRef });
      if (r.status >= 400 || !r.json) throw new AppError('PAY_PROVIDER_ERROR', `PayTabs query: ${(r.json && r.json.message) || `HTTP ${r.status}`}`, 502);
      return normalise(r.json);
    },

    async refund({ tranRef, cartId, amount, currency, reason }) {
      const r = await post('/payment/request', {
        profile_id: profileId, tran_type: 'refund', tran_class: 'ecom', cart_id: cartId, cart_currency: currency, cart_amount: amountOf(amount),
        cart_description: String(reason || 'Refund').slice(0, 100), tran_ref: tranRef,
      });
      if (!r.json) throw new AppError('PAY_PROVIDER_ERROR', `PayTabs refund: HTTP ${r.status}`, 502);
      const n = normalise(r.json);
      return { ok: n.status === 'paid', ref: n.ref, code: n.code, message: n.message, raw: n.raw };
    },

    /** Callback: the "signature" header must be the HMAC of the exact raw body with the server key. */
    verifyCallback(rawBody, signature) { return sameHex(hmac(creds.serverKey, Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody))), signature); },

    /** Return (browser POST): signature over the non-empty fields sorted by name, as PHP http_build_query builds them. */
    verifyReturn(fields) {
      const { signature, ...rest } = fields || {};
      const query = Object.keys(rest).filter((k) => rest[k] !== undefined && rest[k] !== null && rest[k] !== '' && rest[k] !== '0').sort()
        .map((k) => `${phpEncode(k)}=${phpEncode(rest[k])}`).join('&');
      return sameHex(hmac(creds.serverKey, query), signature);
    },

    normalise,

    /** Checks the credentials: an unknown transaction reference must be refused for that reason, not for authentication. */
    async test() {
      const r = await post('/payment/query', { profile_id: profileId, tran_ref: 'TST0000000000000' });
      const msg = String((r.json && r.json.message) || '');
      if (r.status === 401 || r.status === 403 || /authenticat|profile|server key|unauthori/i.test(msg)) return { ok: false, message: msg || `HTTP ${r.status}` };
      if (!r.json) return { ok: false, message: `HTTP ${r.status}` };
      return { ok: true, message: msg };
    },
  };
}

module.exports = { client, REGIONS, phpEncode, hmac };
