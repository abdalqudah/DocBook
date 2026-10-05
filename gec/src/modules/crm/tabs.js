// Tabs on the student page; modules add theirs (applications, documents, shortlist, messages, payments…).
//   add({ key, icon, perms, order, load: async (req, student) => locals, view: 'pages/staff/students/tab-x', count?: async (student) => n })
const TABS = [];
const add = (tab) => { if (!TABS.some((t) => t.key === tab.key)) { TABS.push(tab); TABS.sort((a, b) => a.order - b.order); } };
const forStaff = (req) => TABS.filter((t) => !t.perms || t.perms.some((p) => req.can(p)));
module.exports = { add, forStaff, TABS };
