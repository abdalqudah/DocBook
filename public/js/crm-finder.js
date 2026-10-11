// Admin → CRM → find clinics on Google: "select all" ticks every place on the page.
(function () {
  var all = document.querySelector('[data-finder-all]');
  if (!all) return;
  all.addEventListener('change', function () {
    document.querySelectorAll('[data-finder] input[name="lead"]').forEach(function (b) { b.checked = all.checked; });
  });
}());
