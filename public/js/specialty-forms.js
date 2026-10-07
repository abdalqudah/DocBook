/* Specialty forms: results computed while typing (the server computes them; nothing is saved until "Save"). */
(function () {
  'use strict';
  var form = document.querySelector('form[data-sf-preview]');
  if (!form || !window.fetch || !window.FormData) return;
  var box = form.querySelector('[data-sf-live]');
  var body = form.querySelector('[data-sf-live-body]');
  var url = form.getAttribute('data-sf-preview');
  var timer = null;
  var seq = 0;
  var TONE = { ok: 'badge-success', mild: 'badge-info', warn: 'badge-warning', bad: 'badge-danger' };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }

  function render(data) {
    body.textContent = '';
    if (!data || !data.results || !data.results.length) { box.hidden = true; return; }
    var ul = el('ul', 'sf-results');
    data.results.forEach(function (r) {
      var li = el('li', 'sf-result' + (r.level ? ' is-' + r.level : ''));
      li.appendChild(el('span', 'sf-result-label', r.label));
      var v = el('span', 'sf-result-value', r.value);
      v.setAttribute('dir', 'ltr');
      if (r.unit) { v.appendChild(document.createTextNode(' ')); v.appendChild(el('small', '', r.unit)); }
      li.appendChild(v);
      if (r.band) li.appendChild(el('span', 'badge badge-dot ' + (TONE[r.level] || 'badge-neutral'), r.band));
      ul.appendChild(li);
    });
    body.appendChild(ul);
    box.hidden = false;
  }

  function refresh() {
    var mine = ++seq;
    fetch(url, { method: 'POST', body: new URLSearchParams(new FormData(form)), credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (mine === seq) render(data); })
      .catch(function () { /* the results are shown after saving */ });
  }
  function later() { clearTimeout(timer); timer = setTimeout(refresh, 350); }
  form.addEventListener('input', later);
  form.addEventListener('change', later);
  refresh();
})();
