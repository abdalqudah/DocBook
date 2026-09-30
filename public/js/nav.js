/* Sidebar sections (accordion). Works without JS through <details>/<summary>; this script only remembers which
   sections the user left open (per user and clinic, in localStorage) and keeps the active item in view. */
(function () {
  'use strict';
  var nav = document.querySelector('[data-nav-sections]');
  if (!nav) return;
  var key = 'docbook.nav.' + (nav.getAttribute('data-nav-user') || 'x');
  var state = {};
  try { state = JSON.parse(window.localStorage.getItem(key) || '{}') || {}; } catch (e) { state = {}; }
  var save = function () { try { window.localStorage.setItem(key, JSON.stringify(state)); } catch (e) { /* storage blocked */ } };

  var secs = nav.querySelectorAll('details[data-nav-sec]');
  Array.prototype.forEach.call(secs, function (d) {
    var id = d.getAttribute('data-nav-sec');
    var sum = d.querySelector('summary');
    // The section holding the current page is always open on load; the others follow what the user chose last time.
    if (!d.classList.contains('has-active') && Object.prototype.hasOwnProperty.call(state, id)) d.open = Boolean(state[id]);
    var sync = function () { if (sum) sum.setAttribute('aria-expanded', d.open ? 'true' : 'false'); };
    sync();
    d.addEventListener('toggle', function () { state[id] = d.open; save(); sync(); });
  });

  var active = nav.querySelector('a.active');
  if (active && active.scrollIntoView && nav.scrollHeight > nav.clientHeight) {
    var r = active.getBoundingClientRect(); var nr = nav.getBoundingClientRect();
    if (r.bottom > nr.bottom || r.top < nr.top) active.scrollIntoView({ block: 'center' });
  }

  // Section tabs: keep the current tab visible when the strip scrolls sideways (phones).
  var tab = document.querySelector('.section-tabs-list a.active');
  if (tab && tab.parentNode.scrollWidth > tab.parentNode.clientWidth) {
    var list = tab.parentNode;
    var tr = tab.getBoundingClientRect(); var lr = list.getBoundingClientRect();
    if (tr.left < lr.left || tr.right > lr.right) list.scrollLeft += (tr.left - lr.left) - (lr.width - tr.width) / 2;
  }
}());
