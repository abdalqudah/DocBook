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
  // No cookies inside a third-party frame: keep the language on every form post.
  function keepLang() {
    var lang = document.documentElement.getAttribute('lang');
    if (lang !== 'ar' && lang !== 'en') return;
    var forms = document.querySelectorAll('form[method=post]');
    for (var i = 0; i < forms.length; i += 1) {
      var act = forms[i].getAttribute('action') || window.location.pathname;
      if (!/[?&]lang=/.test(act)) forms[i].setAttribute('action', act + (act.indexOf('?') === -1 ? '?' : '&') + 'lang=' + lang);
    }
  }
  document.addEventListener('DOMContentLoaded', function () { tag(document); keepLang(); });
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-embed-close]') : null;
    if (!el) return;
    e.preventDefault();
    if (window.parent && window.parent !== window) window.parent.postMessage('docbook:close', '*');
    else window.location.href = el.getAttribute('data-href') || '/';
  });
}());
