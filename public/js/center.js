// Medical centre: the account-type choice at sign-up / joining, and the shared reception board refreshing itself.
(function () {
  'use strict';
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  $$('[data-acct-type]').forEach(function (r) {
    // A centre signs up its administration (the centre's name only); a clinic gives its name and specialty.
    var sync = function () {
      if (!r.checked) return;
      var center = r.value === 'center';
      $$('[data-center-only]').forEach(function (b) { b.hidden = !center; $$('input,select', b).forEach(function (i) { i.disabled = !center; }); });
      $$('[data-clinic-only]').forEach(function (b) { b.hidden = center; $$('input,select', b).forEach(function (i) { i.disabled = center; }); });
    };
    r.addEventListener('change', sync); sync();
  });
  $$('[data-join-mode]').forEach(function (r) {
    r.addEventListener('change', function () { $$('[data-join-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-join-pane') !== r.value; }); });
  });
  // Shared expense form: the amount per practice only for "custom amounts".
  $$('[data-ctr-split]').forEach(function (sel) {
    var box = document.querySelector('[data-ctr-custom]');
    var one = document.querySelector('[data-ctr-one]');
    var sync = function () { if (box) box.hidden = sel.value !== 'custom'; if (one) one.hidden = sel.value !== 'one'; };
    sel.addEventListener('change', sync); sync();
  });
  // "I am a doctor too": the practice opens with the admin's own login — no e-mail to type.
  $$('[data-ctr-me]').forEach(function (cb) {
    var box = document.querySelector('[data-ctr-email]');
    var sync = function () { if (!box) return; box.hidden = cb.checked; $$('input', box).forEach(function (i) { i.disabled = cb.checked; }); };
    cb.addEventListener('change', sync); sync();
  });
  // The board: reload every 20 s while nobody is pressing a button (simple and always consistent with the server).
  if (document.querySelector('[data-ctr-desk]')) {
    var busy = false;
    document.addEventListener('submit', function () { busy = true; });
    setInterval(function () { if (!busy && document.visibilityState === 'visible') location.reload(); }, 20000);
  }
}());
