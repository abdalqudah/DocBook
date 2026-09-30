/* Website builder (src/views/pages/website/builder.ejs): preview size and language, drag-and-drop order (the up/down
   buttons do the same without JavaScript), and the preview scrolled to the selected section. */
(function () {
  'use strict';
  var root = document.querySelector('[data-ws-builder]');
  if (!root) return;
  var frame = root.querySelector('[data-ws-frame]');
  var wrap = root.querySelector('[data-ws-frame-wrap]');
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';

  Array.prototype.forEach.call(root.querySelectorAll('[data-ws-device]'), function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(root.querySelectorAll('[data-ws-device]'), function (x) { x.classList.toggle('active', x === b); });
      wrap.classList.toggle('is-mobile', b.getAttribute('data-ws-device') === 'mobile');
    });
  });
  Array.prototype.forEach.call(root.querySelectorAll('[data-ws-lang]'), function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(root.querySelectorAll('[data-ws-lang]'), function (x) { x.classList.toggle('active', x === b); });
      var u = new URL(frame.getAttribute('src'), window.location.href);
      u.searchParams.set('lang', b.getAttribute('data-ws-lang'));
      frame.setAttribute('src', u.pathname + u.search + u.hash);
    });
  });

  // Drag and drop to reorder; saved at once (the list is the order of the draft).
  var list = root.querySelector('[data-ws-order]');
  var dragging = null;
  if (list) {
    list.addEventListener('dragstart', function (e) {
      dragging = e.target.closest ? e.target.closest('li[data-id]') : null;
      if (!dragging) return;
      dragging.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragging.getAttribute('data-id')); } catch (err) { /* old browsers */ }
    });
    list.addEventListener('dragover', function (e) {
      var over = e.target.closest ? e.target.closest('li[data-id]') : null;
      if (!dragging || !over || over === dragging) return;
      e.preventDefault();
      Array.prototype.forEach.call(list.children, function (li) { li.classList.toggle('is-over', li === over); });
    });
    list.addEventListener('drop', function (e) {
      var over = e.target.closest ? e.target.closest('li[data-id]') : null;
      if (!dragging || !over || over === dragging) return;
      e.preventDefault();
      list.insertBefore(dragging, over);
    });
    list.addEventListener('dragend', function () {
      if (!dragging) return;
      dragging.classList.remove('is-dragging');
      Array.prototype.forEach.call(list.children, function (li) { li.classList.remove('is-over'); });
      dragging = null;
      var ids = Array.prototype.map.call(list.querySelectorAll('li[data-id]'), function (li) { return 'ids=' + encodeURIComponent(li.getAttribute('data-id')); }).join('&');
      fetch('/app/website/builder/order', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrf, Accept: 'application/json' }, body: ids })
        .then(function (r) { if (r.ok && frame) frame.contentWindow.location.reload(); else window.location.reload(); })
        .catch(function () { window.location.reload(); });
    });
  }
}());
