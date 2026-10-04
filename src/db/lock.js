// MySQL named locks held on a connection of their own, released only after the work under them has finished —
// including the COMMIT of its transaction. A lock released inside the transaction (before COMMIT) lets a second
// request take it and read before the first one's row is visible, so both would win the same slot.
// The locks always live on the main database's server, so every request for one name meets at the same place,
// whichever database the clinic's data is in.
const tenant = require('./tenant');
const { AppError } = require('../core/errors');

const busy = () => new AppError('SLOT_BUSY', 'The system is busy — please try again.', 409);

/** Runs `fn(take)`; `take(name)` acquires a named lock (waits up to 10 s) that is held until `fn` has returned. */
async function holding(fn) {
  const db = tenant.main;
  const conn = await db.client.acquireConnection();
  const held = [];
  const take = async (name) => {
    const [[{ got }]] = await db.raw('SELECT GET_LOCK(?, 10) AS got', [name]).connection(conn);
    if (Number(got) !== 1) throw busy();
    held.push(name);
  };
  try {
    return await fn(take);
  } finally {
    for (const name of held.reverse()) await db.raw('SELECT RELEASE_LOCK(?)', [name]).connection(conn).catch(() => {}); // eslint-disable-line no-await-in-loop
    await db.client.releaseConnection(conn);
  }
}

/** Runs `fn()` while holding the named lock `name`. */
const withLock = (name, fn) => holding(async (take) => { await take(name); return fn(); });

module.exports = { holding, withLock };
