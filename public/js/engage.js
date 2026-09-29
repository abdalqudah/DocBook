// Review form: live character counter for the comment (progressive enhancement — the form works without it).
(function () {
  'use strict';
  var fields = document.querySelectorAll('textarea[data-count]');
  Array.prototype.forEach.call(fields, function (ta) {
    var out = document.getElementById(ta.getAttribute('data-count'));
    if (!out) return;
    var max = Number(ta.getAttribute('maxlength')) || 1000;
    var update = function () { out.textContent = ta.value.length + ' / ' + max; };
    ta.addEventListener('input', update);
    update();
  });
}());
