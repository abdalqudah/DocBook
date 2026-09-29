/* Marketplace & rep visits: small enhancements (the pages work without this file). */
(function () {
  'use strict';
  function mins(v) { var p = String(v || '').split(':'); return p.length < 2 ? NaN : Number(p[0]) * 60 + Number(p[1]); }
  // Rep window dialog: keep "To" after "From" when the start moves past it.
  var dlg = document.getElementById('window-dialog');
  if (dlg) {
    var start = dlg.querySelector('[name="start_time"]');
    var end = dlg.querySelector('[name="end_time"]');
    var len = dlg.querySelector('[name="slot_minutes"]');
    if (start && end && len) {
      start.addEventListener('change', function () {
        var s = mins(start.value); var e = mins(end.value); var l = Number(len.value) || 15;
        if (!isNaN(s) && (isNaN(e) || e <= s)) {
          var n = Math.min(s + Math.max(l, 60), 23 * 60 + 59);
          end.value = String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
        }
      });
    }
  }
})();
