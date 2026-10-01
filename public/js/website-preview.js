/* Inside the builder's preview (only in /app/website/preview, framed by the builder): a section is outlined on hover
   and selected on click (the builder opens its settings), links do not leave the preview, and the scroll position
   survives the reload after each saved change. */
(function () {
  'use strict';
  if (window.parent === window) return;
  var KEY = 'ws-preview-scroll';
  document.documentElement.classList.add('ws-in-builder');
  try {
    var y = sessionStorage.getItem(KEY);
    if (y !== null && !window.location.hash) window.scrollTo(0, Number(y) || 0);
  } catch (e) { /* storage blocked */ }
  window.addEventListener('scroll', function () { try { sessionStorage.setItem(KEY, String(window.scrollY)); } catch (e) { /* ignore */ } }, { passive: true });

  function mark(id) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-ws-sec]'), function (el) { el.classList.toggle('is-ws-selected', el.getAttribute('data-ws-sec') === id); });
  }
  document.addEventListener('click', function (e) {
    var block = e.target.closest ? e.target.closest('[data-ws-sec]') : null;
    var link = e.target.closest ? e.target.closest('a, button, summary') : null;
    if (link && !block) return; // the preview bar's own button
    if (link) e.preventDefault();
    if (!block) return;
    var id = block.getAttribute('data-ws-sec');
    mark(id);
    window.parent.postMessage({ type: 'ws-select', id: id }, window.location.origin);
  }, true);
  window.addEventListener('message', function (e) {
    if (e.origin !== window.location.origin || !e.data) return;
    if (e.data.type === 'ws-mark') {
      mark(e.data.id);
      var el = document.querySelector('[data-ws-sec="' + String(e.data.id).replace(/[^a-z0-9_]/g, '') + '"]');
      if (el && e.data.scroll) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });
  window.parent.postMessage({ type: 'ws-ready' }, window.location.origin);
}());
