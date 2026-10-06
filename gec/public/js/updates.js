// System update page: while an update is queued or running, poll its status and show the log. The app restarts
// during the update, so failed requests just mean "restarting"; when the run finishes the page reloads.
(function () {
  var box = document.querySelector('[data-update-live="1"]');
  if (!box) return;
  var url = box.getAttribute('data-status-url');
  var stateEl = box.querySelector('[data-update-state]');
  var logEl = document.querySelector('[data-update-log]');
  function tick() {
    fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (s) {
        if (logEl && s.log && s.log.length) { logEl.textContent = s.log.join('\n'); logEl.scrollTop = logEl.scrollHeight; }
        if (!s.queued && s.state !== 'running') { window.location.reload(); return; } // the request was handled
        setTimeout(tick, 4000);
      })
      .catch(function () {
        if (stateEl) stateEl.textContent = box.getAttribute('data-restarting');
        setTimeout(tick, 5000);
      });
  }
  setTimeout(tick, 2000);
}());
