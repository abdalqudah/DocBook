// Shared progressive enhancement for every page. The site works without it; this adds toasts, dialogs,
// confirmations, autosaved drafts, chips and small conveniences. No inline scripts (strict CSP).
(function () {
  'use strict';
  var doc = document;
  var csrf = doc.body.getAttribute('data-csrf') || (doc.querySelector('input[name="_csrf"]') || {}).value || '';
  var GEC = window.GEC = window.GEC || {};
  var rtl = doc.documentElement.dir === 'rtl';

  GEC.csrf = csrf;
  GEC.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  GEC.icon = function (name, cls) { var u = doc.querySelector('svg.icon use'); var base = u ? (u.getAttribute('href') || '').split('#')[0] : '/icons.svg'; return '<svg class="icon ' + (cls || '') + '" aria-hidden="true"><use href="' + base + '#i-' + name + '"></use></svg>'; };

  /** JSON fetch with the CSRF header; rejects with { message } on errors. */
  GEC.api = function (url, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json', 'X-CSRF-Token': csrf };
    var body = opts.body;
    if (body && !(body instanceof FormData) && typeof body !== 'string') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    return fetch(url, { method: opts.method || 'GET', headers: headers, body: body, credentials: 'same-origin' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok || data.ok === false) { var err = new Error((data.error && data.error.message) || 'Request failed'); err.data = data; err.status = r.status; throw err; }
        return data;
      });
    });
  };

  // ---- Toasts
  var toastBox = doc.querySelector('.toasts');
  GEC.toast = function (message, type, action) {
    if (!toastBox) { toastBox = doc.createElement('div'); toastBox.className = 'toasts'; toastBox.setAttribute('role', 'status'); doc.body.appendChild(toastBox); }
    var el = doc.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.innerHTML = GEC.icon(type === 'error' ? 'alert-circle' : 'check-circle-2') + '<span></span>' + (action ? '<button type="button"></button>' : '');
    el.querySelector('span').textContent = message;
    if (action) { var b = el.querySelector('button'); b.textContent = action.label; b.addEventListener('click', function () { action.run(); el.remove(); }); }
    toastBox.appendChild(el);
    setTimeout(function () { el.remove(); }, type === 'error' ? 8000 : 5000);
  };
  if (toastBox && toastBox.hasAttribute('data-autohide')) {
    setTimeout(function () { toastBox.querySelectorAll('.toast:not(.error)').forEach(function (t) { t.remove(); }); }, 5000);
  }
  doc.addEventListener('click', function (e) {
    var d = e.target.closest('[data-dismiss]'); if (d) { d.closest('.toast, .alert, [data-dismissable]').remove(); }
  });

  // ---- Confirmation for destructive actions: <form data-confirm="Delete this lead?">
  doc.addEventListener('submit', function (e) {
    var f = e.target;
    var msg = f.getAttribute('data-confirm') || (e.submitter && e.submitter.getAttribute('data-confirm'));
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    // Prevent double submission; re-enable after a while for back-navigation.
    var btn = e.submitter || f.querySelector('[type="submit"]');
    if (btn && !f.hasAttribute('data-multi')) { setTimeout(function () { btn.disabled = true; }, 0); setTimeout(function () { btn.disabled = false; }, 6000); }
  });

  // ---- Dialogs: <button data-dialog-open="id">, <button data-dialog-close>
  doc.addEventListener('click', function (e) {
    var o = e.target.closest('[data-dialog-open]');
    if (o) { var dlg = doc.getElementById(o.getAttribute('data-dialog-open')); if (dlg && dlg.showModal) { e.preventDefault(); dlg.showModal(); var first = dlg.querySelector('input:not([type=hidden]), select, textarea'); if (first) first.focus(); } }
    var c = e.target.closest('[data-dialog-close]');
    if (c) { var d = c.closest('dialog'); if (d) d.close(); }
  });
  doc.querySelectorAll('dialog.dialog').forEach(function (d) {
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); }); // click on backdrop
  });
  doc.querySelectorAll('dialog[data-open-on-load]').forEach(function (d) { if (d.showModal) d.showModal(); });

  // ---- Close <details class="menu"> when clicking elsewhere or pressing Escape
  doc.addEventListener('click', function (e) {
    doc.querySelectorAll('details.menu[open]').forEach(function (m) { if (!m.contains(e.target)) m.removeAttribute('open'); });
  });
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') doc.querySelectorAll('details.menu[open]').forEach(function (m) { m.removeAttribute('open'); var s = m.querySelector('summary'); if (s) s.focus(); });
  });

  // ---- Chip checkboxes
  doc.addEventListener('change', function (e) {
    var c = e.target.closest('[data-toggle-chip]');
    if (c) c.closest('label').classList.toggle('on', c.checked);
  });

  // ---- Auto-submit filters: <select data-autosubmit>
  doc.addEventListener('change', function (e) {
    var s = e.target.closest('[data-autosubmit]');
    if (s && s.form) s.form.requestSubmit ? s.form.requestSubmit() : s.form.submit();
  });

  // ---- Theme
  doc.addEventListener('click', function (e) {
    if (!e.target.closest('[data-theme-cycle]')) return;
    var root = doc.documentElement;
    var cur = root.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    var next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('gec_theme', next); } catch (err) { /* ignore */ }
  });

  // ---- Draft autosave: <form data-autosave="key"> keeps unsent text in this browser until submitted.
  doc.querySelectorAll('form[data-autosave]').forEach(function (form) {
    var key = 'gec_draft_' + form.getAttribute('data-autosave');
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { saved = null; }
    if (saved && saved.v) {
      Object.keys(saved.v).forEach(function (name) {
        var el = form.elements[name];
        if (!el || el.type === 'hidden' || el.type === 'password' || el.type === 'file') return;
        if (el.type === 'checkbox') el.checked = !!saved.v[name]; else if (!el.value) el.value = saved.v[name];
      });
      var note = form.querySelector('[data-draft-note]'); if (note) note.hidden = false;
    }
    var timer;
    form.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var v = {};
        Array.prototype.forEach.call(form.elements, function (el) {
          if (!el.name || el.type === 'hidden' || el.type === 'password' || el.type === 'file' || el.name === '_csrf' || el.hasAttribute('data-no-draft')) return;
          v[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        });
        try { localStorage.setItem(key, JSON.stringify({ v: v, at: Date.now() })); } catch (e) { /* full */ }
      }, 400);
    });
    form.addEventListener('submit', function () { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } });
  });

  // ---- Copy to clipboard: <button data-copy="text">
  doc.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (!b) return;
    navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () { GEC.toast(b.getAttribute('data-copied') || 'Copied'); });
  });

  // ---- Print
  doc.addEventListener('click', function (e) { if (e.target.closest('[data-print]')) { e.preventDefault(); window.print(); } });

  // ---- Platform key label (⌘ on Mac)
  if (/Mac|iPhone|iPad/.test(navigator.platform || '')) doc.querySelectorAll('[data-kbd-mod]').forEach(function (k) { k.textContent = '⌘ K'; });

  GEC.rtl = rtl;
}());

// Open a dialog when the page asks for it: <span data-open-dialog="id" hidden>
(function () {
  var m = document.querySelector('[data-open-dialog]');
  if (m) { var d = document.getElementById(m.getAttribute('data-open-dialog')); if (d && d.showModal) d.showModal(); }
}());
