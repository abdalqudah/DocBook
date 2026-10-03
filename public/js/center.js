// Medical centre: the account-type choice at sign-up / joining, and the shared reception board refreshing itself.
(function () {
  'use strict';
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  $$('[data-acct-type]').forEach(function (r) {
    r.addEventListener('change', function () { $$('[data-center-only]').forEach(function (b) { b.hidden = r.value !== 'center'; }); });
  });
  $$('[data-join-mode]').forEach(function (r) {
    r.addEventListener('change', function () { $$('[data-join-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-join-pane') !== r.value; }); });
  });
  // The board: reload every 20 s while nobody is pressing a button (simple and always consistent with the server).
  if (document.querySelector('[data-ctr-desk]')) {
    var busy = false;
    document.addEventListener('submit', function () { busy = true; });
    setInterval(function () { if (!busy && document.visibilityState === 'visible') location.reload(); }, 20000);
  }
}());
