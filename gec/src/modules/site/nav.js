// Public site navigation. Modules add their pages as they are built; Website → Navigation (CMS) can override.
const LINKS = []; // { key, href, order }
const add = (l) => { if (!LINKS.some((x) => x.key === l.key)) LINKS.push(l); LINKS.sort((a, b) => a.order - b.order); };
module.exports = { LINKS, add };
