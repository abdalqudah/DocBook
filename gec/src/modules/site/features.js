// Which public features exist in this build (modules enable theirs), so the header never links to a missing page.
const on = new Set();
module.exports = { enable: (k) => on.add(k), has: (k) => on.has(k) };
