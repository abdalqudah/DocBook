// Extension points modules use to plug into the staff workspace without the shell knowing about them:
//   palette search providers, palette actions, "New" quick actions and "Needs attention" queue sources.
const search = []; // async (req, q) => ({ key, label, items: [{ title, sub, href, icon }] }) — must respect req.can and data scope
const actions = []; // { key, icon, href, perms: [] } — shown in the palette and the "New" menu
const attention = []; // async (req) => [{ kind, icon, tone, title, sub, href, due }]

const addSearch = (fn) => search.push(fn);
const addAction = (a) => { if (!actions.some((x) => x.key === a.key)) actions.push(a); };
const addAttention = (fn) => attention.push(fn);

const actionsFor = (req) => actions.filter((a) => a.perms.some((p) => req.can(p)));

module.exports = { search, actions, attention, addSearch, addAction, addAttention, actionsFor };
