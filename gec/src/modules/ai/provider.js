// AI provider adapter. Today: Anthropic Claude through the official SDK. Another provider can be added behind the
// same `chat({ system, messages, tools })` call. Credentials live in Settings → AI advisor (encrypted).
const settings = require('../settings/settings.service');
const secrets = require('../../core/secrets');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'];
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];
let testDouble = null; // tests replace the provider; nothing else does
const useTestProvider = (fn) => { testDouble = fn; };

async function currentConfig() {
  if (testDouble) return { provider: 'test', model: 'test-model', effort: 'medium' };
  const s = (await settings.get('integration.ai')) || {};
  if (!s.enabled || !s.api_key_enc) return null;
  const key = secrets.decrypt(s.api_key_enc);
  if (!key) return null;
  return { provider: 'anthropic', apiKey: key, model: s.model || DEFAULT_MODEL, effort: ['low', 'medium', 'high'].includes(s.effort) ? s.effort : 'medium' };
  // (Haiku 4.5 does not take an effort setting.)
}

/**
 * One model turn. Returns { content: [blocks], stopReason, usage, model } in the Messages API shape.
 * Refusals come back as stopReason 'refusal' (the caller answers politely instead).
 */
async function chat(cfg, { system, messages, tools }) {
  if (testDouble) return testDouble({ system, messages, tools });
  const Anthropic = require('@anthropic-ai/sdk'); // eslint-disable-line global-require
  const Client = Anthropic.default || Anthropic;
  const client = new Client({ apiKey: cfg.apiKey, timeout: 60_000, maxRetries: 2 });
  const params = { model: cfg.model, max_tokens: 4096, system, messages, tools };
  if (!/haiku/.test(cfg.model)) params.output_config = { effort: cfg.effort };
  // On models that support it: if the model declines on a safety category, the API retries on a fallback model.
  if (FALLBACK_MODELS.includes(cfg.model)) Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  const res = await client.beta.messages.create(params);
  return { content: res.content, stopReason: res.stop_reason, usage: res.usage, model: res.model };
}

module.exports = { currentConfig, chat, useTestProvider, DEFAULT_MODEL, MODELS };
