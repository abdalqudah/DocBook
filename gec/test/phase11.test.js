const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { knex, resetDb, makeStaff, staffAgent, agent } = require('./helpers');

const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];
const form = async (a, url, body) => { const t = await a.token(); return a.post(url).type('form').send({ _csrf: t, ...body }); };
// 1×1 PNG (width 1, height 1) and a 3×2 one.
const png = (w, h) => {
  const b = Buffer.from('89504e470d0a1a0a0000000d49484452000000000000000008060000001f15c4890000000d4944415478da6300010000050001a5f645400000000049454e44ae426082', 'hex');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b;
};

let admin; let marketing; let manager; let otherBranchManager; let counsellor; let finance; let student;
test.before(async () => {
  await resetDb();
  admin = await makeStaff({ role: 'super_admin' });
  marketing = await makeStaff({ role: 'marketing' });
  manager = await makeStaff({ role: 'branch_manager' });
  const [b2] = await knex('branches').insert({ name: 'Second branch' });
  otherBranchManager = await makeStaff({ role: 'branch_manager', branchId: b2 });
  counsellor = await makeStaff({ role: 'counsellor' });
  finance = await makeStaff({ role: 'finance' });
  const [sid] = await knex('students').insert({ ref: 'S-P11001', first_name: 'Hala', email: 'hala@example.com', counsellor_id: counsellor.employee.id, branch_id: counsellor.employee.branch_id });
  student = await knex('students').where({ id: sid }).first();
});
test.after(() => knex.destroy());

test('event and course registrants follow ownership: branch, organiser, instructor, company-wide roles', async () => {
  const at = new Date(Date.now() + 7 * 86400_000);
  const [own] = await knex('events').insert({ slug: 'branch-fair', title_en: 'Branch fair', starts_at: at, branch_id: manager.employee.branch_id });
  const [company] = await knex('events').insert({ slug: 'company-webinar', title_en: 'Company webinar', starts_at: at, organizer_id: otherBranchManager.employee.id });
  const m = await staffAgent(manager);
  assert.equal((await m.get(`/staff/events/${own}/registrations`)).status, 200, 'own branch');
  assert.equal((await m.get(`/staff/events/${company}/registrations?format=csv`)).status, 404, 'company-wide event: not a branch manager’s registrants');
  const o = await staffAgent(otherBranchManager);
  assert.equal((await o.get(`/staff/events/${company}/registrations`)).status, 200, 'the organiser');
  assert.equal((await o.get(`/staff/events/${own}/registrations`)).status, 404, 'another branch');
  const mk = await staffAgent(marketing);
  assert.equal((await mk.get(`/staff/events/${company}/registrations`)).status, 200, 'company-wide role');
  const [course] = await knex('courses').insert({ slug: 'ielts-branch', name_en: 'IELTS', branch_id: manager.employee.branch_id });
  assert.equal((await m.get(`/staff/courses/${course}/registrations`)).status, 200);
  assert.equal((await o.get(`/staff/courses/${course}/registrations`)).status, 404);
  // The ownership fields are on the forms
  const f = await mk.get(`/staff/events/${company}`);
  assert.match(f.text, /name="organizer_id"/); assert.match(f.text, /name="branch_id"/);
});

test('media library: upload with dimensions and alt text, picker, usage blocks deletion, only images, permissions', async () => {
  const mk = await staffAgent(marketing);
  let t = await mk.token();
  const up = await mk.post('/staff/media').field('_csrf', t).field('alt_en', 'Campus at sunset').field('alt_ar', 'الحرم الجامعي').attach('file', png(3, 2), 'campus.png');
  assert.equal(up.status, 302);
  const m = await knex('media').where({ purpose: 'cms' }).orderBy('id', 'desc').first();
  assert.equal(m.width, 3); assert.equal(m.height, 2); assert.equal(m.is_public, 1); assert.equal(m.alt_en, 'Campus at sunset');
  assert.equal((await (await agent()).get(`/media/${m.id}`)).status, 200, 'served publicly');
  const pick = await mk.get('/staff/media/picker.json?q=campus');
  assert.equal(JSON.parse(pick.text).data[0].url, `/media/${m.id}`);
  t = await mk.token();
  const bad = await mk.post('/staff/media').field('_csrf', t).attach('file', Buffer.from('<svg onload="alert(1)"></svg>'), 'x.png');
  assert.notEqual(bad.status, 200);
  assert.equal(Number((await knex('media').where({ purpose: 'cms' }).count({ n: '*' }))[0].n), 1, 'non-images refused');
  // In use → cannot be deleted
  const [art] = await knex('articles').insert({ slug: 'campus-life', title_en: 'Campus life', image: `/media/${m.id}`, is_published: true, published_at: new Date() });
  const page = await mk.get(`/staff/media/${m.id}`);
  assert.match(page.text, /Article #\d+/);
  await form(mk, `/staff/media/${m.id}/delete`, {});
  assert.ok(await knex('media').where({ id: m.id }).first(), 'kept while used');
  await knex('articles').where({ id: art }).update({ image: null });
  await form(mk, `/staff/media/${m.id}/delete`, {});
  assert.equal(await knex('media').where({ id: m.id }).first(), undefined, 'deleted when unused');
  // Image fields offer the picker
  assert.match((await mk.get('/staff/articles/new')).text, /data-media-pick="#f_image"/);
  const c = await staffAgent(counsellor);
  assert.equal((await c.get('/staff/media')).status, 403);
});

test('importing external images: each address downloaded once, content repointed, failures leave content unchanged', async () => {
  const media = require('../src/modules/cms/media.service');
  const at = new Date(Date.now() + 86400_000);
  const [e1] = await knex('events').insert({ slug: 'ev-img-1', title_en: 'A', starts_at: at, image: 'https://img.example.com/photo-1.jpg?w=800' });
  const [e2] = await knex('events').insert({ slug: 'ev-img-2', title_en: 'B', starts_at: at, image: 'https://img.example.com/photo-1.jpg?w=800' });
  const [a1] = await knex('articles').insert({ slug: 'img-article', title_en: 'C', image: 'https://img.example.com/missing.jpg' });
  const [a2] = await knex('articles').insert({ slug: 'img-article-2', title_en: 'D', image: 'https://img.example.com/page.html' });
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.includes('missing')) return new Response('nope', { status: 404 });
    if (url.includes('page.html')) return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(png(8, 6), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const r = await media.importExternal({ userId: admin.user.id }, { fetchImpl });
  assert.equal(r.imported, 1); assert.equal(r.rows, 2); assert.equal(r.failed.length, 2);
  assert.equal(calls, 3, 'the shared address was downloaded once');
  const ev1 = await knex('events').where({ id: e1 }).first(); const ev2 = await knex('events').where({ id: e2 }).first();
  assert.match(ev1.image, /^\/media\/\d+$/); assert.equal(ev1.image, ev2.image);
  const m = await knex('media').where({ source_url: 'https://img.example.com/photo-1.jpg?w=800' }).first();
  assert.equal(m.width, 8); assert.equal(m.is_public, 1);
  assert.equal((await knex('articles').where({ id: a1 }).first()).image, 'https://img.example.com/missing.jpg', 'failed download: unchanged');
  assert.equal((await knex('articles').where({ id: a2 }).first()).image, 'https://img.example.com/page.html', 'not an image: unchanged');
  assert.ok(await knex('audit_logs').where({ action: 'media.imported' }).first());
  await knex('articles').whereIn('id', [a1, a2]).del();
});

test('card payments via Stripe: not connected → no button; checkout; signed webhook records once; review on overpayment', async () => {
  const online = require('../src/modules/finance/online');
  const requests = [];
  online.useFetch(async (url, opts) => {
    requests.push({ url, opts });
    if (url.endsWith('/balance')) return new Response(JSON.stringify({ livemode: false }), { status: 200 });
    if (url.endsWith('/checkout/sessions')) return new Response(JSON.stringify({ id: `cs_test_${requests.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${requests.length}` }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  const f = await staffAgent(finance);
  await form(f, '/staff/invoices', { student_id: student.id, currency: 'USD', locale: 'en', item_description: ['Application service'], item_quantity: ['1'], item_unit_price: ['400'] });
  const inv = await knex('invoices').where({ student_id: student.id }).first();
  await form(f, `/staff/invoices/${inv.id}/issue`, {});
  const issued = await knex('invoices').where({ id: inv.id }).first();
  const pub = await agent();
  let page = await pub.get(`/invoices/${issued.public_token}`);
  assert.doesNotMatch(page.text, /Pay by card/, 'no button while not connected');
  const anyForm = await pub.get('/contact');
  const refused = await pub.post(`/invoices/${issued.public_token}/pay`).type('form').send({ _csrf: csrfOf(anyForm.text) });
  assert.notEqual(refused.status, 303);

  // Connect (keys are checked against Stripe and stored encrypted)
  const sa = await staffAgent(admin);
  await form(sa, '/staff/settings/payments', { enabled: '1', secret_key: 'sk_test_abcdefghijklmnop', webhook_secret: 'whsec_testsecret1234567890' });
  const stored = await knex('settings').where({ key: 'integration.stripe' }).first();
  assert.doesNotMatch(JSON.stringify(stored.value), /sk_test_abcdef|whsec_testsecret/, 'secrets encrypted');
  assert.ok(requests.some((r) => r.url.endsWith('/balance')));

  page = await pub.get(`/invoices/${issued.public_token}`);
  assert.match(page.text, /Pay by card/);
  const go = await pub.post(`/invoices/${issued.public_token}/pay`).type('form').send({ _csrf: csrfOf(page.text) });
  assert.equal(go.status, 303); assert.match(go.headers.location, /^https:\/\/checkout\.stripe\.com\//);
  const sent = requests.find((r) => r.url.endsWith('/checkout/sessions'));
  const params = new URLSearchParams(sent.opts.body);
  assert.equal(params.get('line_items[0][price_data][unit_amount]'), '40000'); assert.equal(params.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(params.get('metadata[invoice_id]'), String(inv.id)); assert.match(sent.opts.headers.Authorization, /^Bearer sk_test_/);
  const ps = await knex('payment_sessions').where({ invoice_id: inv.id }).first();
  assert.equal(ps.status, 'open');
  // Coming back from Stripe does not mark anything paid
  await pub.get(`/invoices/${issued.public_token}?paid=1`);
  assert.equal((await knex('invoices').where({ id: inv.id }).first()).status, 'issued');

  const hook = async (event, secret = 'whsec_testsecret1234567890', ts = Math.floor(Date.now() / 1000)) => {
    const body = JSON.stringify(event);
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    return (await agent()).post('/hooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', `t=${ts},v1=${sig}`).send(body);
  };
  const paidEvent = { type: 'checkout.session.completed', data: { object: { id: ps.session_id, payment_status: 'paid', amount_total: 40000, payment_intent: 'pi_123' } } };
  assert.equal((await hook(paidEvent, 'whsec_wrong')).status, 400, 'bad signature refused');
  assert.equal((await hook(paidEvent, undefined, Math.floor(Date.now() / 1000) - 3600)).status, 400, 'old timestamp refused');
  const ok = await hook(paidEvent);
  assert.equal(ok.status, 200); assert.equal(ok.body.result, 'recorded');
  const after = await knex('invoices').where({ id: inv.id }).first();
  assert.equal(after.status, 'paid');
  const pays = await knex('payments').where({ invoice_id: inv.id });
  assert.equal(pays.length, 1); assert.equal(pays[0].method, 'online'); assert.equal(pays[0].reference, 'pi_123');
  assert.equal((await hook(paidEvent)).body.result, 'duplicate', 'a retried webhook is not recorded twice');
  assert.equal((await knex('payments').where({ invoice_id: inv.id })).length, 1);

  // A second checkout started before the balance was settled elsewhere → flagged for review, not recorded
  await knex('payment_sessions').insert({ invoice_id: inv.id, provider: 'stripe', session_id: 'cs_late', amount: 400, currency: 'USD', status: 'open' });
  const late = await hook({ type: 'checkout.session.completed', data: { object: { id: 'cs_late', payment_status: 'paid', amount_total: 40000, payment_intent: 'pi_late' } } });
  assert.equal(late.body.result, 'needs_review');
  assert.ok(await knex('notifications').where({ user_id: finance.user.id }).where('title_en', 'like', '%needs review%').first(), 'finance is told');
  assert.equal((await knex('payments').where({ invoice_id: inv.id })).length, 1);

  // Currency units
  assert.equal(online.toMinor(12.5, 'JOD'), 12500); assert.equal(online.toMinor(1000, 'JPY'), 1000); assert.equal(online.toMinor(10.01, 'EUR'), 1001);
  assert.equal(online.fromMinor(12500, 'JOD'), 12.5);
});
