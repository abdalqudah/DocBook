// Footer link columns; modules add links as their pages exist.
const COLS = { study: [], company: [], students: [] };
const add = (col, link) => { if (COLS[col] && !COLS[col].some((l) => l.href === link.href)) COLS[col].push(link); };
const columns = () => Object.entries(COLS).filter(([, links]) => links.length).map(([key, links]) => ({ key, links }));
module.exports = { add, columns };
