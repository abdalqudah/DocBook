// Admin → CRM → a bulk e-mail campaign: "select all" ticks every contact listed.
(function () {
  var all = document.querySelector('[data-camp-all]');
  if (!all) return;
  all.addEventListener('change', function () {
    document.querySelectorAll('[data-camp-people] input[name="contact"]').forEach(function (b) { b.checked = all.checked; });
  });
}());
