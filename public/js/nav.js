/* Workspace tabs (src/views/partials/section-tabs.ejs): keep the current tab visible when the strip scrolls sideways
   (phones), and keep the active sidebar line in view when the menu scrolls. */
(function () {
  'use strict';
  var nav = document.querySelector('.nav-workspaces');
  var active = nav && nav.querySelector('a.active');
  if (active && active.scrollIntoView && nav.scrollHeight > nav.clientHeight) {
    var r = active.getBoundingClientRect(); var nr = nav.getBoundingClientRect();
    if (r.bottom > nr.bottom || r.top < nr.top) active.scrollIntoView({ block: 'center' });
  }
  var tab = document.querySelector('.section-tabs-list a.active');
  if (tab && tab.parentNode.scrollWidth > tab.parentNode.clientWidth) {
    var list = tab.parentNode;
    var tr = tab.getBoundingClientRect(); var lr = list.getBoundingClientRect();
    if (tr.left < lr.left || tr.right > lr.right) list.scrollLeft += (tr.left - lr.left) - (lr.width - tr.width) / 2;
  }
}());
