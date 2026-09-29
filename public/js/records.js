/* Records area (patients, billing, dashboard, my day, reports) — progressive enhancements only. */
(function () {
  'use strict';
  // Live pages (the doctor's day, today's schedule) refresh themselves while visible and idle.
  var live = document.querySelector('[data-autorefresh]');
  if (live) {
    var every = Math.max(30, Number(live.getAttribute('data-autorefresh')) || 90) * 1000;
    var last = Date.now();
    ['keydown', 'pointerdown', 'input'].forEach(function (ev) { document.addEventListener(ev, function () { last = Date.now(); }, { passive: true }); });
    setInterval(function () {
      if (document.hidden) return;
      if (document.querySelector('dialog[open]')) return;
      var a = document.activeElement;
      if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
      if (Date.now() - last < 20000) return;
      window.location.reload();
    }, every);
  }
  // Close any other open export menu when one opens (reports has several).
  var menus = document.querySelectorAll('details.rec-exp');
  Array.prototype.forEach.call(menus, function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open) return;
      Array.prototype.forEach.call(menus, function (o) { if (o !== d) o.open = false; });
    });
  });
  document.addEventListener('click', function (e) {
    Array.prototype.forEach.call(menus, function (d) { if (d.open && !d.contains(e.target)) d.open = false; });
  });
}());
