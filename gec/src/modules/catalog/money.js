// Currency normalisation: catalogue amounts keep their own currency; search, budgets and matching compare in USD.
// Rates are editable (Settings → Currencies) and are only an estimate — pages say so.
const knex = require('../../db/knex');

let rates = null;
let loadedAt = 0;
async function load() {
  if (!rates || Date.now() - loadedAt > 60_000) {
    rates = Object.fromEntries((await knex('currency_rates').select('code', 'per_usd')).map((r) => [r.code, Number(r.per_usd)]));
    loadedAt = Date.now();
  }
  return rates;
}
const clear = () => { rates = null; };

async function toUsd(amount, currency = 'USD') {
  if (amount === null || amount === undefined || amount === '') return null;
  const r = (await load())[String(currency).toUpperCase()];
  return r ? Math.round(Number(amount) / r) : null;
}
async function fromUsd(amount, currency = 'USD') {
  if (amount === null || amount === undefined) return null;
  const r = (await load())[String(currency).toUpperCase()];
  return r ? Math.round(Number(amount) * r) : null;
}
async function convert(amount, from, to) {
  if (from === to) return amount;
  const usd = await toUsd(amount, from);
  return usd === null ? null : fromUsd(usd, to);
}
async function codes() { return Object.keys(await load()).sort(); }

module.exports = { toUsd, fromUsd, convert, codes, load, clear };
