// Admin → CRM → board: drag a card to another stage (desktop) or pick the stage in its menu (phone); saved at once.
(function () {
  var board = document.querySelector('[data-crm-board]');
  if (!board) return;
  var csrf = board.getAttribute('data-csrf');
  var count = function () { board.querySelectorAll('.crm-col').forEach(function (c) { c.querySelector('[data-count]').textContent = c.querySelectorAll('[data-card]').length; }); };
  var toast = function (msg, kind) {
    var box = document.querySelector('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    var el = document.createElement('div'); el.className = 'toast ' + kind; var txt = document.createElement('div'); txt.className = 'grow'; txt.textContent = msg; el.appendChild(txt); box.appendChild(el);
    setTimeout(function () { el.remove(); }, 2500);
  };
  function move(card, stage) {
    var from = card.parentNode; var next = card.nextSibling;
    var col = board.querySelector('.crm-col[data-stage="' + stage + '"] [data-drop]');
    if (!col || col === from) return;
    col.insertBefore(card, col.firstChild); card.querySelector('[data-card-stage]').value = stage; count();
    fetch('/admin/crm/' + card.getAttribute('data-card') + '/stage', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ _csrf: csrf, stage: stage }).toString() })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.ok) throw new Error(d.error || ''); toast(board.getAttribute('data-moved'), 'success'); })
      .catch(function () { from.insertBefore(card, next); card.querySelector('[data-card-stage]').value = from.closest('.crm-col').getAttribute('data-stage'); count(); toast(board.getAttribute('data-failed'), 'error'); });
  }
  var dragged = null;
  board.addEventListener('dragstart', function (e) { var c = e.target.closest && e.target.closest('[data-card]'); if (!c) return; dragged = c; c.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.getAttribute('data-card')); });
  board.addEventListener('dragend', function () { if (dragged) dragged.classList.remove('is-dragging'); dragged = null; board.querySelectorAll('.is-over').forEach(function (x) { x.classList.remove('is-over'); }); });
  board.addEventListener('dragover', function (e) { var col = e.target.closest && e.target.closest('.crm-col'); if (!col || !dragged) return; e.preventDefault(); board.querySelectorAll('.is-over').forEach(function (x) { if (x !== col) x.classList.remove('is-over'); }); col.classList.add('is-over'); });
  board.addEventListener('drop', function (e) { var col = e.target.closest && e.target.closest('.crm-col'); if (!col || !dragged) return; e.preventDefault(); col.classList.remove('is-over'); move(dragged, col.getAttribute('data-stage')); });
  board.addEventListener('change', function (e) { var s = e.target.closest('[data-card-stage]'); if (s) move(s.closest('[data-card]'), s.value); });
}());
