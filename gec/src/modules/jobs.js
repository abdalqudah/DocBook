// Background jobs (one process): reminders, automations, recurring tasks. Each job is idempotent and records what it
// did, so running twice (or in two processes) does not duplicate messages.
const JOBS = [];
const register = (name, everyMs, fn) => JOBS.push({ name, everyMs, fn, running: false });

function start() {
  for (const job of JOBS) {
    const tick = async () => {
      if (job.running) return;
      job.running = true;
      try { await job.fn(); } catch (e) { console.error(`[jobs] ${job.name}:`, e.message); } finally { job.running = false; } // eslint-disable-line no-console
    };
    setTimeout(tick, 5000).unref();
    setInterval(tick, job.everyMs).unref();
  }
}

/** Runs every job once (tests and `npm run jobs`). */
async function runAll() { for (const job of JOBS) await job.fn(); } // eslint-disable-line no-await-in-loop

module.exports = { register, start, runAll, JOBS };
