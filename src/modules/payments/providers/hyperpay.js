// HyperPay — COPYandPAY (OPPWA platform). https://wordpresshyperpay.docs.oppwa.com/integrations/widget
//   1. POST {base}/v1/checkouts (entityId, amount, currency, paymentType=DB, merchantTransactionId…) → checkout id
//   2. the patient types the card in HyperPay's widget: {base}/v1/paymentWidgets.js?checkoutId=<id>
//   3. HyperPay sends the browser back to shopperResultUrl?id=<checkout id>&resourcePath=…
//   4. verify on the server: GET {base}/v1/checkouts/{id}/payment?entityId=… → result.code (regex below)
//   refund: POST {base}/v1/payments/{payment id} (entityId, amount, currency, paymentType=RF)
// Authentication: "Authorization: Bearer <access token>". Each card brand family has its own entity id —
// VISA/MASTER on one, MADA on another (mada must be processed on its own entity in Saudi Arabia).
const { request } = require('./http');
const { AppError } = require('../../../core/errors');

const BASES = { test: 'https://eu-test.oppwa.com', live: 'https://eu-prod.oppwa.com' };
const BRANDS = { card: 'VISA MASTER', mada: 'MADA' };

// Result codes (HyperPay "Result codes" page): successful transactions, pending, everything else is a failure.
const SUCCESS = /^(000\.000\.|000\.100\.1|000\.[36])/;
const REVIEW = /^(000\.400\.0[^3]|000\.400\.100)/; // successful but flagged for manual review → treated as pending
const PENDING = /^(000\.200)|^(800\.400\.5|100\.400\.500)/;
const CHECKOUT_CREATED = /^000\.200\.100$/;

const statusOf = (code) => (SUCCESS.test(code) ? 'paid' : REVIEW.test(code) || PENDING.test(code) ? 'pending' : 'failed');

/** HyperPay amounts always have two decimals ("12.50"). */
const amountOf = (v) => Number(v).toFixed(2);

function client(creds) {
  const base = BASES[creds.mode === 'live' ? 'live' : 'test'];
  const entity = (brand) => (brand === 'mada' ? creds.entityMada : creds.entityCard);
  if (!creds.accessToken || !creds.entityCard) throw new AppError('PAY_NOT_CONFIGURED', 'HyperPay is not configured.', 409);
  const headers = { authorization: `Bearer ${creds.accessToken}`, accept: 'application/json' };
  const form = (fields) => new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

  function normalise(j) {
    const code = String((j && j.result && j.result.code) || '');
    return {
      status: statusOf(code), code, message: String((j && j.result && j.result.description) || '').slice(0, 250),
      paymentId: j && j.id ? String(j.id) : null, cartId: j && j.merchantTransactionId ? String(j.merchantTransactionId) : null,
      amount: j && j.amount !== undefined ? Number(j.amount) : null, currency: j && j.currency ? String(j.currency).toUpperCase() : null,
      raw: j ? { id: j.id, paymentType: j.paymentType, paymentBrand: j.paymentBrand, amount: j.amount, currency: j.currency, merchantTransactionId: j.merchantTransactionId, result: j.result, timestamp: j.timestamp, ndc: j.ndc } : null,
    };
  }

  return {
    provider: 'hyperpay', base, brands: BRANDS,
    hasBrand: (brand) => Boolean(entity(brand)),

    /** Creates a checkout for one brand family. → { ref (checkout id), integrity } */
    async createPayment({ cartId, amount, currency, brand = 'card', customer = {} }) {
      if (!entity(brand)) throw new AppError('PAY_NOT_CONFIGURED', 'This card type is not set up.', 409);
      const [given, ...rest] = String(customer.name || '').trim().split(/\s+/);
      const r = await request(`${base}/v1/checkouts`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          entityId: entity(brand), amount: amountOf(amount), currency, paymentType: 'DB', merchantTransactionId: cartId,
          'customer.email': customer.email, 'customer.givenName': given, 'customer.surname': rest.join(' ') || given, 'billing.country': customer.country,
          // Test environment: card brands are routed to the external test simulator; mada uses the internal one.
          ...(creds.mode !== 'live' && brand !== 'mada' ? { testMode: 'EXTERNAL' } : {}),
        }),
      });
      const code = String((r.json && r.json.result && r.json.result.code) || '');
      if (!r.json || !r.json.id || !CHECKOUT_CREATED.test(code)) {
        throw new AppError('PAY_PROVIDER_ERROR', `HyperPay: ${(r.json && r.json.result && r.json.result.description) || `HTTP ${r.status}`}`, 502);
      }
      return { ref: String(r.json.id), integrity: r.json.integrity ? String(r.json.integrity) : null };
    },

    widgetUrl: (checkoutId) => `${base}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(checkoutId)}`,

    /** The real state of a checkout's payment, asked from HyperPay's server. */
    async verify(checkoutId, brand = 'card') {
      if (!/^[A-Za-z0-9.\-_]{8,64}$/.test(String(checkoutId || ''))) throw new AppError('PAY_PROVIDER_ERROR', 'Invalid checkout id.', 400);
      const r = await request(`${base}/v1/checkouts/${encodeURIComponent(checkoutId)}/payment?entityId=${encodeURIComponent(entity(brand) || '')}`, { headers });
      if (!r.json) throw new AppError('PAY_PROVIDER_ERROR', `HyperPay status: HTTP ${r.status}`, 502);
      return normalise(r.json);
    },

    async refund({ paymentId, amount, currency, brand = 'card' }) {
      const r = await request(`${base}/v1/payments/${encodeURIComponent(paymentId)}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ entityId: entity(brand), amount: amountOf(amount), currency, paymentType: 'RF' }),
      });
      if (!r.json) throw new AppError('PAY_PROVIDER_ERROR', `HyperPay refund: HTTP ${r.status}`, 502);
      const n = normalise(r.json);
      return { ok: n.status === 'paid', ref: n.paymentId, code: n.code, message: n.message, raw: n.raw };
    },

    normalise,

    /** Checks the credentials by creating a small checkout (nothing is charged; it simply expires). */
    async test() {
      try {
        await this.createPayment({ cartId: `test-${Date.now()}`, amount: 1, currency: creds.currency || 'JOD', brand: 'card' });
        return { ok: true, message: '' };
      } catch (e) { return { ok: false, message: e.message }; }
    },
  };
}

module.exports = { client, BASES, BRANDS, statusOf, amountOf };
