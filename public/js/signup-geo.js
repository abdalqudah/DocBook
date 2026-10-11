// Sign-up: choosing the country picks its time zone and currency; on a fresh form the visitor's own time zone (from
// the browser) is preselected, with its country when known.
(function () {
  var cc = document.querySelector('[data-geo-country]');
  if (!cc) return;
  var form = cc.form;
  var zone = form.querySelector('[name="timezone"]');
  var cur = form.querySelector('[name="currency"]');
  var has = function (sel, v) { return sel && Array.prototype.some.call(sel.options, function (o) { return o.value === v; }); };
  cc.addEventListener('change', function () {
    var o = cc.selectedOptions[0];
    if (!o) return;
    var z = o.getAttribute('data-zone'); var c = o.getAttribute('data-currency');
    if (z && has(zone, z)) zone.value = z;
    if (c && has(cur, c)) cur.value = c;
  });
  if (!cc.value) {
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { tz = ''; }
    if (tz && has(zone, tz)) {
      zone.value = tz;
      var match = Array.prototype.find.call(cc.options, function (o) { return o.getAttribute('data-zone') === tz; });
      if (match) { cc.value = match.value; var c2 = match.getAttribute('data-currency'); if (c2 && has(cur, c2)) cur.value = c2; }
    }
  }
}());
