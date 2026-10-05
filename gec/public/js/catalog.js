// Catalogue pages: save / compare toggles without reloading, filter drawer on phones.
(function () {
  'use strict';
  var doc = document;
  var GEC = window.GEC;

  doc.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-toggle-form]');
    if (!form) return;
    e.preventDefault();
    var kind = form.getAttribute('data-toggle-form');
    var btn = form.querySelector('button');
    var data = new URLSearchParams(new FormData(form));
    fetch(form.action, { method: 'POST', body: data, headers: { Accept: 'application/json', 'X-CSRF-Token': GEC.csrf }, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.ok === false) throw new Error((j.error && j.error.message) || 'Error'); return j; }); })
      .then(function (j) {
        btn.setAttribute('aria-pressed', String(j.on));
        var label = btn.getAttribute(j.on ? 'data-label-on' : 'data-label-off');
        btn.setAttribute('aria-label', label); btn.title = label;
        if (kind === 'shortlist') btn.innerHTML = GEC.icon(j.on ? 'bookmark-check' : 'bookmark');
        var bar = doc.querySelector('[data-compare-bar]');
        if (kind === 'compare' && bar) {
          var n = (j.ids || []).length;
          bar.hidden = n === 0;
          var c = bar.querySelector('[data-compare-count]'); if (c) c.textContent = String(n);
        }
        GEC.toast(label === btn.getAttribute('data-label-on') ? (doc.body.getAttribute('data-locale') === 'ar' ? 'تم' : 'Done') : (doc.body.getAttribute('data-locale') === 'ar' ? 'تمت الإزالة' : 'Removed'));
      })
      .catch(function (err) { GEC.toast(err.message, 'error'); });
  });

  var ft = doc.querySelector('[data-filters-toggle]');
  var fp = doc.querySelector('[data-filters]');
  if (ft && fp) ft.addEventListener('click', function () { var open = fp.classList.toggle('open'); ft.setAttribute('aria-expanded', String(open)); });
}());
