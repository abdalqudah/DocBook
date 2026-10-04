// Test helper: the real app on a random port with a cookie jar (login, CSRF token from the page).
const http = require('http');

async function serve() {
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  const server = await new Promise((resolve) => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  const agent = () => {
    const jar = {};
    const send = (method, path, form, extraHeaders = {}) => new Promise((resolve, reject) => {
      const body = form ? new URLSearchParams(form).toString() : '';
      const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), host: `127.0.0.1:${port}`, ...extraHeaders };
      if (form) Object.assign(headers, { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) });
      const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        for (const h of res.headers['set-cookie'] || []) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
        const chunks = [];
        res.on('data', (d) => { chunks.push(d); });
        res.on('end', () => { const body = Buffer.concat(chunks); resolve({ status: res.statusCode, location: res.headers.location || null, type: res.headers['content-type'] || '', text: body.toString('utf8'), body, csp: res.headers['content-security-policy'] || '' }); });
      });
      r.on('error', reject); r.end(body);
    });
    const csrf = (html) => (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
    const a = {
      get: (p, h) => send('GET', p, null, h), post: (p, f, h) => send('POST', p, f, h), csrf,
      async login(email, password = 'Passw0rd!x') {
        const page = await send('GET', '/login');
        const r = await send('POST', '/login', { _csrf: csrf(page.text), email, password });
        if (r.status !== 302) throw new Error(`login failed for ${email}: ${r.status}`);
        return r;
      },
      /** POST multipart form data (files: { field: { buffer, name } }) with the CSRF token of `fromPath`. */
      async upload(fromPath, path, fields = {}, files = {}) {
        const p = await send('GET', fromPath);
        const fd = new FormData();
        fd.append('_csrf', csrf(p.text));
        Object.entries(fields).forEach(([k, v]) => [].concat(v).forEach((x) => fd.append(k, x)));
        Object.entries(files).forEach(([k, f]) => fd.append(k, new Blob([f.buffer]), f.name));
        const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: fd, redirect: 'manual', headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
        (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach((h) => { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); });
        return { status: r.status, location: r.headers.get('location'), type: r.headers.get('content-type') || '', text: await r.text() };
      },
      /** POST a form with the CSRF token of `fromPath`. */
      async submit(fromPath, path, form) { const p = await send('GET', fromPath); return send('POST', path, { _csrf: csrf(p.text), ...form }); },
    };
    return a;
  };
  return { server, agent, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { serve };
