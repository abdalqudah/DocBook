// Admin → CRM → find clinics: "select all" ticks every place on the page; the collector page copies its code.
(function () {
  var all = document.querySelector('[data-finder-all]');
  if (all) {
    all.addEventListener('change', function () {
      document.querySelectorAll('[data-finder] input[name="lead"]').forEach(function (b) { b.checked = all.checked; });
    });
  }
  // The collector button is meant to be dragged to the bookmarks bar; a click here only says so.
  var link = document.querySelector('[data-collector-link]');
  if (link) link.addEventListener('click', function (e) { e.preventDefault(); alert(link.getAttribute('title')); });
  var copy = document.querySelector('[data-collector-copy]');
  var code = document.querySelector('[data-collector-code]');
  if (copy && code) {
    copy.addEventListener('click', function () {
      code.select();
      var done = function () { copy.textContent = copy.getAttribute('data-done'); };
      if (navigator.clipboard) navigator.clipboard.writeText(code.value).then(done, function () { document.execCommand('copy'); done(); });
      else { document.execCommand('copy'); done(); }
    });
  }
}());
