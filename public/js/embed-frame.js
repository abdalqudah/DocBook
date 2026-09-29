/* Booking page inside the DocBook booking widget (embed mode): links leave the frame in a new tab, and the
   "Close" button asks the host page to close the overlay. */
(function () {
  'use strict';
  function tag(root) {
    var links = (root || document).querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i += 1) {
      var h = links[i].getAttribute('href') || '';
      if (h.charAt(0) === '#' || /^(tel|mailto):/i.test(h)) continue;
      links[i].setAttribute('target', '_blank');
      links[i].setAttribute('rel', 'noopener');
    }
  }
  document.addEventListener('DOMContentLoaded', function () { tag(document); });
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-embed-close]') : null;
    if (!el) return;
    e.preventDefault();
    if (window.parent && window.parent !== window) window.parent.postMessage('docbook:close', '*');
    else window.location.href = el.getAttribute('data-href') || '/';
  });
}());
