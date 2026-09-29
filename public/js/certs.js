// Medical documents: issue form helpers (leave end date, show/hide optional fields). Progressive enhancement —
// the form works without this script.
(function () {
  'use strict';
  var form = document.querySelector('[data-cert-form]');
  if (!form) return;
  var isAr = document.documentElement.lang === 'ar';

  // Last day of leave = first day + days − 1.
  var start = form.querySelector('[data-leave-start]');
  var days = form.querySelector('[data-leave-days]');
  var out = form.querySelector('[data-leave-end]');
  function updateEnd() {
    if (!start || !days || !out) return;
    var n = parseInt(days.value, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start.value) || !(n >= 1)) { out.textContent = '—'; return; }
    var d = new Date(start.value + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n - 1);
    try {
      out.textContent = new Intl.DateTimeFormat(isAr ? 'ar-EG-u-ca-gregory-nu-latn' : 'en-GB', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
    } catch (e) { out.textContent = d.toISOString().slice(0, 10); }
  }
  if (start && days) { start.addEventListener('input', updateEnd); days.addEventListener('input', updateEnd); updateEnd(); }

  // Optional sections follow their checkbox (diagnosis on a sick leave, companion details).
  Array.prototype.forEach.call(form.querySelectorAll('[data-toggle-target]'), function (box) {
    var target = document.getElementById(box.getAttribute('data-toggle-target'));
    if (!target) return;
    var sync = function () { target.hidden = !box.checked; };
    box.addEventListener('change', sync);
    sync();
  });
})();
