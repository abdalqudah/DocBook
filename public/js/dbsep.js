// Platform admin → Clinic databases: follows the background moves (every 2 s while they run), reloads at the end.
(function () {
  'use strict';
  var box = document.querySelector('[data-dbsep]');
  if (!box || box.getAttribute('data-running') !== '1') return;
  var bar = box.querySelector('[data-dbsep-bar]'); var text = box.querySelector('[data-dbsep-text]');
  var tick = function () {
    fetch('/admin/databases/status', { headers: { accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      var j = d.job || {}; var n = (j.done || 0) + (j.failed || 0);
      if (j.total && bar) bar.style.width = Math.round((n / j.total) * 100) + '%';
      if (j.total && text) text.textContent = box.getAttribute('data-progress-text').replace('{done}', n).replace('{total}', j.total);
      if (j.running) setTimeout(tick, 2000); else location.reload();
    }).catch(function () { setTimeout(tick, 5000); });
  };
  setTimeout(tick, 1500);
}());
