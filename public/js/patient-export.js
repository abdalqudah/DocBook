// Whole-clinic patient export page: follows the running export and reloads when it is ready.
(function () {
  var box = document.querySelector('[data-export-running]');
  if (!box) return;
  var text = box.querySelector('[data-export-text]');
  var bar = box.querySelector('[data-export-bar]');
  var tpl = text.getAttribute('data-text-running');
  var nf = new Intl.NumberFormat(document.documentElement.lang || undefined);
  function tick() {
    fetch(box.getAttribute('data-status'), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s.state !== 'running') { window.location.reload(); return; }
        if (s.total) {
          text.textContent = tpl.replace('{done}', nf.format(s.done)).replace('{total}', nf.format(s.total));
          bar.style.width = Math.round((s.done * 100) / s.total) + '%';
        }
        setTimeout(tick, 2000);
      })
      .catch(function () { setTimeout(tick, 5000); });
  }
  setTimeout(tick, 1500);
}());
