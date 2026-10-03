// Reps billing pages: ad price preview; offer targeting (specialty/cities vs chosen clinics) with clinic search + count.
(function () {
  'use strict';
  var form = document.querySelector('[data-ad-form]');
  if (form) {
    var days = form.querySelector('[data-ad-days]');
    var out = form.querySelector('[data-ad-total]');
    var per = Number(form.getAttribute('data-per-day')) || 0;
    var free = Number(form.getAttribute('data-free-left')) || 0;
    var cur = form.getAttribute('data-currency') || '';
    var lang = document.documentElement.lang || 'ar';
    var paint = function () {
      var n = Math.max(0, Math.round(Number(days.value) || 0));
      var total = n && n <= free ? 0 : n * per;
      var txt;
      try { txt = new Intl.NumberFormat(lang === 'ar' ? 'ar-JO-u-nu-latn' : 'en-JO', { style: 'currency', currency: cur, maximumFractionDigits: 3 }).format(total); } catch (e) { txt = total.toFixed(2) + ' ' + cur; }
      out.textContent = txt;
    };
    if (days && out) { days.addEventListener('input', paint); paint(); }
  }
  var box = document.querySelector('[data-offer-target]');
  if (box) {
    var boxes = box.querySelectorAll('[data-target-box]');
    var show = function () {
      var v = (box.querySelector('input[name="target"]:checked') || {}).value || 'specialty';
      boxes.forEach(function (b) { b.hidden = b.getAttribute('data-target-box') !== v; });
    };
    box.querySelectorAll('input[name="target"]').forEach(function (r) { r.addEventListener('change', show); });
    show();
    var search = box.querySelector('[data-clinic-search]');
    var rows = box.querySelectorAll('[data-clinic-row]');
    if (search) search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase();
      rows.forEach(function (r) { r.hidden = q && r.getAttribute('data-q').indexOf(q) === -1; });
    });
    var count = box.querySelector('[data-clinic-count]');
    var max = count && count.getAttribute('data-max') ? Number(count.getAttribute('data-max')) : null;
    var recount = function () {
      var n = box.querySelectorAll('input[name="clinic_ids"]:checked').length;
      if (count) { count.textContent = n + (max !== null ? ' / ' + max : ''); count.classList.toggle('badge-danger', max !== null && n > max); }
    };
    box.addEventListener('change', function (e) { if (e.target.name === 'clinic_ids') recount(); });
    recount();
  }
}());
