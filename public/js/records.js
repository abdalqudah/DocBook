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

/* Patient timeline filter (patient workspace → Timeline): show one kind of entry at a time. */
(function () {
  'use strict';
  var bar = document.querySelector('[data-pt-filter]');
  if (!bar) return;
  var list = document.querySelector('.rec-timeline');
  bar.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-kind]') : null;
    if (!b || !list) return;
    var kind = b.getAttribute('data-kind');
    Array.prototype.forEach.call(bar.querySelectorAll('[data-kind]'), function (x) { var on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    Array.prototype.forEach.call(list.children, function (li) {
      var k = li.getAttribute('data-kind');
      // A visit line also holds its prescriptions and invoice, so it stays visible for those filters when it has them.
      var has = kind === 'all' || k === kind || (k === 'visit' && ((kind === 'prescription' && li.querySelector('[href*="/prescriptions/"]')) || (kind === 'invoice' && li.querySelector('[href^="/app/billing/"]')) || (kind === 'diagnosis' && li.querySelector('use[href$="#i-stethoscope"]'))));
      li.hidden = !has;
    });
  });
}());
