// Platform admin → Compress old images: follows the background job (every 2 s while it runs) and reloads at the end.
(function () {
  'use strict';
  var box = document.querySelector('[data-io]');
  if (!box || box.getAttribute('data-running') !== '1') return;
  var bar = box.querySelector('[data-io-bar]'); var text = box.querySelector('[data-io-text]');
  var tick = function () {
    fetch('/admin/images/status', { headers: { accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      var j = d.job || {};
      if (j.total) {
        bar.style.width = Math.round((j.done / j.total) * 100) + '%';
        text.textContent = box.getAttribute('data-progress-text').replace('{done}', j.done).replace('{total}', j.total);
      }
      if (j.running) setTimeout(tick, 2000); else location.reload();
    }).catch(function () { setTimeout(tick, 5000); });
  };
  setTimeout(tick, 1500);
}());
