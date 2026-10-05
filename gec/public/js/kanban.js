// Kanban drag and drop: moving a card calls the API; on failure the card goes back. Keyboard and touch users
// change the stage from the record page (same server rule).
(function () {
  'use strict';
  var board = document.querySelector('[data-kanban]');
  if (!board) return;
  var GEC = window.GEC;
  var endpoint = board.getAttribute('data-endpoint');
  var dragged = null;
  var from = null;

  board.addEventListener('dragstart', function (e) {
    var card = e.target.closest('.kcard');
    if (!card) return;
    dragged = card; from = card.parentElement;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.getAttribute('data-id'));
  });
  board.addEventListener('dragend', function () { if (dragged) dragged.classList.remove('dragging'); board.querySelectorAll('.drop-target').forEach(function (c) { c.classList.remove('drop-target'); }); });
  board.addEventListener('dragover', function (e) {
    var col = e.target.closest('.kanban-cards');
    if (!col || !dragged) return;
    e.preventDefault();
    board.querySelectorAll('.drop-target').forEach(function (c) { if (c !== col) c.classList.remove('drop-target'); });
    col.classList.add('drop-target');
  });
  board.addEventListener('drop', function (e) {
    var col = e.target.closest('.kanban-cards');
    if (!col || !dragged) return;
    e.preventDefault();
    col.classList.remove('drop-target');
    if (col === from) return;
    var card = dragged;
    var origin = from;
    var body = { stage_id: Number(col.getAttribute('data-stage')) };
    if (col.getAttribute('data-lost') === '1') {
      var reason = window.prompt(board.getAttribute('data-lost-prompt') || 'Reason');
      if (!reason) return;
      body.reason = reason;
    }
    col.prepend(card);
    count(origin, -1); count(col, 1);
    GEC.api(endpoint.replace('{id}', card.getAttribute('data-id')), { method: 'PATCH', body: body }).then(function (r) {
      GEC.toast(r.message || 'OK');
    }).catch(function (err) {
      origin.prepend(card); count(origin, 1); count(col, -1);
      GEC.toast(err.message, 'error');
    });
  });
  function count(cards, delta) {
    var el = cards.parentElement.querySelector('[data-count]');
    if (el) el.textContent = String(Math.max(0, Number(el.textContent) + delta));
  }
}());
