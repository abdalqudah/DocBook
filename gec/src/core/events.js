// In-process domain events. Modules publish facts ("lead.created", "application.stage_changed"); automations,
// lead scoring, notifications and the activity timeline subscribe. Handlers never break the action that emitted
// the event: failures are logged.
const handlers = new Map();

function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, []);
  handlers.get(name).push(fn);
}

/** Runs every handler for `name` (and '*') in order; resolves when all have finished. */
async function emit(name, payload = {}) {
  const list = [...(handlers.get(name) || []), ...(handlers.get('*') || [])];
  for (const fn of list) {
    try { await fn(payload, name); } // eslint-disable-line no-await-in-loop
    catch (e) { console.error(`[events] ${name} handler failed:`, e.message); } // eslint-disable-line no-console
  }
}

module.exports = { on, emit };
