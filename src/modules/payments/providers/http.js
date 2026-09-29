// The only place payment providers are called over HTTP. `fetch` is injectable so tests (and a future proxy) can
// replace it; every call has a timeout and returns { status, json, text } — never throws for an HTTP error status.
const { AppError } = require('../../../core/errors');

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Replaces the fetch used for provider calls (tests). Returns the previous one. */
function setFetch(fn) { const prev = fetchImpl; fetchImpl = fn || ((...args) => globalThis.fetch(...args)); return prev; }

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (err) {
    throw new AppError('PAY_PROVIDER_UNREACHABLE', `Payment provider unreachable: ${err.message}`, 502);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

module.exports = { request, setFetch };
