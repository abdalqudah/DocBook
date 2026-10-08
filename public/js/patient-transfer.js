// Patients → move / share to another clinic: ticking patients in the list, choosing the clinic (reloads its doctors),
// and the progress of a running transfer.
(function () {
  'use strict';
  var bar = document.querySelector('[data-transfer-select]');
  if (bar) {
    var boxes = function () { return Array.prototype.slice.call(document.querySelectorAll('input[name="ids"][form="pt-select"]')); };
    var all = document.querySelector('[data-transfer-all]');
    var count = bar.querySelector('[data-transfer-count]'); var go = bar.querySelector('[data-transfer-go]');
    var update = function () {
      var n = boxes().filter(function (b) { return b.checked; }).length;
      count.textContent = count.getAttribute('data-text').replace('{n}', n);
      go.disabled = !n;
      if (all) { all.checked = n && n === boxes().length; all.indeterminate = n > 0 && n < boxes().length; }
    };
    boxes().forEach(function (b) { b.addEventListener('change', update); });
    if (all) all.addEventListener('change', function () { boxes().forEach(function (b) { b.checked = all.checked; }); update(); });
    update();
  }
  document.querySelectorAll('[data-transfer-pick] select[data-autosubmit]').forEach(function (s) { s.addEventListener('change', function () { s.form.submit(); }); });
  var job = document.querySelector('[data-transfer-job]');
  if (job && job.getAttribute('data-live')) {
    var tick = function () {
      fetch(job.getAttribute('data-status-url'), { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) {
        if (s.status !== 'queued' && s.status !== 'running') { window.location.reload(); return; }
        var m = job.querySelector('.meter > span'); if (m && s.total) m.style.width = Math.round((s.done + s.failed) * 100 / s.total) + '%';
        setTimeout(tick, 2000);
      }).catch(function () { setTimeout(tick, 5000); });
    };
    setTimeout(tick, 1500);
  }
}());
