/* Appointment drawer (Appointments page): a click on an appointment opens its essentials and next actions in a side
   panel (GET /app/appointments/:id/peek) instead of leaving the list or calendar. Ctrl/⌘/middle click, or no JS, still
   open the full page; if the drawer cannot load, the full page opens. */
(function () {
  'use strict';
  var root = document.querySelector('[data-peek-root]');
  if (!root || typeof window.fetch !== 'function') return;
  var dlg = document.createElement('dialog');
  dlg.className = 'drawer';
  dlg.setAttribute('aria-label', root.getAttribute('data-peek-label') || '');
  document.body.appendChild(dlg);
  var here = window.location.pathname + window.location.search;
  var close = function () { if (dlg.open) dlg.close(); };
  dlg.addEventListener('click', function (e) {
    if (e.target === dlg || (e.target.closest && e.target.closest('[data-peek-close]'))) close();
  });
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !root.contains(a) || a.hasAttribute('data-no-peek')) return;
    var m = a.getAttribute('href').match(/^\/app\/appointments\/(\d+)$/);
    if (!m || a.classList.contains('is-dragging')) return;
    e.preventDefault();
    fetch('/app/appointments/' + m[1] + '/peek?return=' + encodeURIComponent(here), { credentials: 'same-origin', headers: { Accept: 'text/html' } })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then(function (html) {
        dlg.innerHTML = html;
        if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
        var first = dlg.querySelector('.peek-actions .btn, [data-peek-close]'); if (first) first.focus();
      })
      .catch(function () { window.location.href = a.getAttribute('href'); });
  });
}());
